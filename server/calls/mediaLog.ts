/**
 * A `leave` that arrives after the call already ended (both sides hang up; the server tore the media session down
 * with the call) is expected and harmless — the SFU session is already gone. Log it at info, not warn, so real
 * media failures stay visible in `[calls] media request failed`.
 */
export const BENIGN_LEAVE_ERRORS = new Set(["UDP media isn't available"]);

export function isBenignMediaFailure(method: string, error: unknown): boolean {
  return method === "leave" && BENIGN_LEAVE_ERRORS.has(String(error ?? ""));
}
