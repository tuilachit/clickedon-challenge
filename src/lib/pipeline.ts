import { extractJson, TruncatedResponseError } from "./extract-json";
import { mockStream, type MockBehavior, type MockState } from "./anthropic-mock";

export interface GenerateInput {
  /** Drives the mock streaming client (see anthropic-mock.ts). */
  behavior: MockBehavior;
  /** Hands the finished draft to the next pipeline stage. May reject. */
  advanceToNextStage: () => Promise<void>;
  /** Returns true once the draft passes review. Scripted by callers/tests. */
  reviewPasses: (attempt: number) => boolean;
  /** Delay between stream retries. Injectable so callers can control timing. */
  sleep?: (ms: number) => Promise<void>;
}

/** Which stage of the pass failed, for callers that need to route the error. */
export type FailureStage = "stream" | "review" | "handoff";

export interface GenerateResult {
  status: "ok" | "error";
  attempts: number;
  error?: { stage: FailureStage; cause: unknown };
}

/** Revisions permitted after the initial draft is reviewed. */
const MAX_REVISIONS = 3;

/**
 * Total stream attempts. Three is the minimum that survives the worst transient
 * case we model: two consecutive 429s followed by a success.
 */
const MAX_STREAM_ATTEMPTS = 3;

const RETRY_BASE_MS = 100;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function statusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * A dropped stream or an overloaded API is worth another attempt. A response
 * with no JSON at all, or with a malformed body inside a closed fence, is a
 * deterministic failure — re-streaming would just burn quota.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof TruncatedResponseError) return true;
  const status = statusOf(err);
  if (status === undefined) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

type DraftOutcome = { ok: true } | { ok: false; cause: unknown };

/** Streams and extracts a draft, retrying only transient failures. */
async function streamDraft(
  input: GenerateInput,
  state: MockState,
): Promise<DraftOutcome> {
  const sleep = input.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
    try {
      const text = await mockStream(input.behavior, state);
      extractJson(text);
      return { ok: true };
    } catch (err) {
      if (!isRetryable(err)) {
        return { ok: false, cause: err };
      }
      lastError = err;
      if (attempt < MAX_STREAM_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }

  return { ok: false, cause: lastError };
}

/**
 * Runs one content-generation pass: stream a draft, extract it, revise until it
 * passes review, then hand off to the next stage.
 *
 * Every failure path returns `status: "error"` with the stage that failed; none
 * of them are swallowed.
 */
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const state: MockState = { calls: 0 };

  const draft = await streamDraft(input, state);
  if (!draft.ok) {
    return {
      status: "error",
      attempts: 0,
      error: { stage: "stream", cause: draft.cause },
    };
  }

  // Review the initial draft, then revise up to MAX_REVISIONS times. A reviewer
  // that throws is itself a review-stage failure, not an exception for the
  // caller to catch.
  let attempt = 0;
  let passed = false;
  try {
    passed = input.reviewPasses(attempt);
    while (!passed && attempt < MAX_REVISIONS) {
      attempt += 1;
      passed = input.reviewPasses(attempt);
    }
  } catch (cause) {
    return {
      status: "error",
      attempts: attempt,
      error: { stage: "review", cause },
    };
  }

  // A draft that never passed review must not reach the next stage.
  if (!passed) {
    return {
      status: "error",
      attempts: attempt,
      error: {
        stage: "review",
        cause: new Error(
          `Draft failed review after ${MAX_REVISIONS} revisions`,
        ),
      },
    };
  }

  // The hand-off is not retried: it carries no idempotency key, so a second
  // call risks delivering the draft downstream twice.
  try {
    await input.advanceToNextStage();
  } catch (cause) {
    return { status: "error", attempts: attempt, error: { stage: "handoff", cause } };
  }

  return { status: "ok", attempts: attempt };
}

export { MAX_REVISIONS, MAX_STREAM_ATTEMPTS };
