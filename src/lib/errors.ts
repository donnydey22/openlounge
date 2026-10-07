// User-facing error copy. Raw transport / auth / server-internal messages never reach the UI:
// they become one calm line. Human messages written by the server ("@sam is taken", "Enter a valid
// phone number", "This room has ended") pass through unchanged.

export const NETWORK_COPY = "Couldn't connect. Tap to try again.";
export const GENERIC_COPY = "That didn't go through. Try again.";

const TECHNICAL =
  /unauthori[sz]ed|forbidden|invalid token|not signed in|session expired|\b40[0-9]\b|\b50[0-9]\b|server error|unknown event|internal|exception|stack|undefined|null|nan\b|typeerror|syntaxerror|referenceerror|json|^error:|fetch|econn|socket|websocket/i;
const TRANSPORT = /not connected|connection lost|timed out|timeout|network|failed to fetch|load failed|offline|aborted/i;

/** An error whose message is safe to show; `transient` = connectivity (callers may stay quiet and retry). */
export class FriendlyError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

export function isTransient(e: unknown): boolean {
  return !!(e as { transient?: boolean } | null)?.transient;
}

export function friendlyMessage(raw: unknown, fallback = GENERIC_COPY): string {
  const msg = typeof raw === "string" ? raw : (raw as { message?: unknown } | null)?.message;
  if (raw instanceof FriendlyError) return raw.message;
  if (typeof msg !== "string" || !msg.trim()) return fallback;
  if (TRANSPORT.test(msg)) return NETWORK_COPY;
  if (TECHNICAL.test(msg) || msg.length > 140) return fallback;
  return msg;
}

/** Normalize anything thrown into a FriendlyError. */
export function toFriendly(e: unknown, fallback = GENERIC_COPY): FriendlyError {
  if (e instanceof FriendlyError) return e;
  const msg = (e as { message?: unknown } | null)?.message;
  const transient = isTransient(e) || (typeof msg === "string" && TRANSPORT.test(msg));
  return new FriendlyError(transient ? NETWORK_COPY : friendlyMessage(e, fallback), transient);
}
