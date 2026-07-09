/**
 * Thrown when a response opens a ```json fence but never closes it — the
 * signature of a dropped stream. Distinct from "the model returned no JSON at
 * all", because only the former is worth re-streaming.
 */
export class TruncatedResponseError extends Error {
  constructor(message = "Fenced JSON block is unterminated (truncated stream)") {
    super(message);
    this.name = "TruncatedResponseError";
  }
}

const FENCED_BLOCK = /```json\s*([\s\S]*?)```/;
const FENCE_OPEN = "```json";

/**
 * True when the text tails off inside an unterminated fence that had started
 * emitting JSON — the signature of a dropped stream.
 *
 * Merely containing "```json" is not enough: a model that only *talks* about
 * fences has failed permanently, and retrying it would burn the budget for
 * nothing. We require the trailing fence to be followed by the start of a JSON
 * value.
 */
function endsInUnterminatedJsonFence(text: string): boolean {
  const open = text.lastIndexOf(FENCE_OPEN);
  if (open === -1) return false;
  const tail = text.slice(open + FENCE_OPEN.length).trimStart();
  return tail.startsWith("{") || tail.startsWith("[");
}

/**
 * Pulls the JSON object out of a fenced ```json ... ``` block in a model
 * response. This mirrors the real pipeline's extractor.
 *
 * Note: a model response can arrive truncated (a dropped stream), in which case
 * the closing fence is missing.
 */
export function extractJson<T = unknown>(text: string): T {
  const match = text.match(FENCED_BLOCK);
  if (!match) {
    if (endsInUnterminatedJsonFence(text)) {
      throw new TruncatedResponseError();
    }
    throw new Error("No fenced JSON block found");
  }
  return JSON.parse(match[1]) as T;
}
