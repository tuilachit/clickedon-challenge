import { describe, it, expect, vi } from "vitest";
import { generate } from "../lib/pipeline";
import { extractJson, TruncatedResponseError } from "../lib/extract-json";

const noSleep = async () => {};

/**
 * The gate tests assert on `status` alone. That leaves a hole: a pipeline that
 * reported "error" but still pushed the rejected draft downstream would pass
 * every one of them. Withholding a failed draft is the behaviour that actually
 * protects the next stage, so it deserves a test.
 */
describe("a draft that fails review is never handed off", () => {
  it("does not call advanceToNextStage when review never passes", async () => {
    const advanceToNextStage = vi.fn(async () => {});

    const res = await generate({
      behavior: "ok",
      advanceToNextStage,
      reviewPasses: () => false,
      sleep: noSleep,
    });

    expect(res.status).toBe("error");
    expect(res.error?.stage).toBe("review");
    expect(advanceToNextStage).not.toHaveBeenCalled();
  });

  it("reviews the initial draft, then revises exactly MAX_REVISIONS times", async () => {
    const reviewPasses = vi.fn<(attempt: number) => boolean>(() => false);

    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => {},
      reviewPasses,
      sleep: noSleep,
    });

    // attempt 0 is the initial draft; 1..3 are the revisions.
    expect(reviewPasses.mock.calls.map(([n]) => n)).toEqual([0, 1, 2, 3]);
    expect(res.attempts).toBe(3);
  });

  it("does not revise a draft that passes on the first review", async () => {
    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => {},
      reviewPasses: (attempt) => attempt === 0,
      sleep: noSleep,
    });

    expect(res).toEqual({ status: "ok", attempts: 0 });
  });
});

describe("failures are attributed to the stage that produced them", () => {
  it("treats a throwing reviewer as a review-stage failure, not an exception", async () => {
    const cause = new Error("review service down");
    const advanceToNextStage = vi.fn(async () => {});

    const res = await generate({
      behavior: "ok",
      advanceToNextStage,
      reviewPasses: () => {
        throw cause;
      },
      sleep: noSleep,
    });

    expect(res.status).toBe("error");
    expect(res.error).toEqual({ stage: "review", cause });
    expect(advanceToNextStage).not.toHaveBeenCalled();
  });

  it("reports the hand-off as the failing stage, preserving the cause", async () => {
    const cause = new Error("next stage unreachable");

    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => {
        throw cause;
      },
      reviewPasses: () => true,
      sleep: noSleep,
    });

    expect(res.error).toEqual({ stage: "handoff", cause });
  });
});

describe("backoff runs between stream retries", () => {
  it("waits with exponential delays while retrying two rate limits", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const res = await generate({
      behavior: "transient-429-twice",
      advanceToNextStage: async () => {},
      reviewPasses: () => true,
      sleep,
    });

    expect(res.status).toBe("ok");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });
});

describe("extractJson separates a dropped stream from an absent one", () => {
  it("flags an unterminated fence as truncated, so the caller can retry", () => {
    const truncated = 'Here you go:\n\n```json\n{"title":"Five ways to impro';
    expect(() => extractJson(truncated)).toThrow(TruncatedResponseError);
  });

  it("treats a response with no fence as a permanent failure", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(
      "No fenced JSON block found",
    );
  });

  it("treats a stream that died on the fence opener as truncated", () => {
    // The stream emitted the fence and nothing else. There is no JSON to
    // inspect, but this is still a dropped stream and must be retried.
    expect(() => extractJson("Here you go:\n\n```json")).toThrow(
      TruncatedResponseError,
    );
    expect(() => extractJson("Here you go:\n\n```json\n")).toThrow(
      TruncatedResponseError,
    );
  });

  it("does not mistake prose about fences for a dropped stream", () => {
    // A model that only talks about ```json has failed permanently. Calling
    // that "truncated" would spend the whole retry budget on a certain failure.
    const prose = "I cannot produce that. Wrap your output in ```json fences.";
    expect(() => extractJson(prose)).not.toThrow(TruncatedResponseError);
    expect(() => extractJson(prose)).toThrow("No fenced JSON block found");
  });

  it("reads the first complete block even when a second fence is left open", () => {
    const text = '```json\n{"title":"first"}\n```\n\n```json\n{"title":"sec';
    expect(extractJson(text)).toEqual({ title: "first" });
  });

  it("does not retry malformed JSON inside a closed fence", () => {
    // A complete fence with a broken body is deterministic — re-streaming it
    // would burn quota for the same result.
    const malformed = '```json\n{"title": unquoted}\n```';
    expect(() => extractJson(malformed)).not.toThrow(TruncatedResponseError);
    expect(() => extractJson(malformed)).toThrow(SyntaxError);
  });
});
