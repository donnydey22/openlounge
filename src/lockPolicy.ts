// Pure lock policy (no native imports, unit-tested in scripts/check-bridge.cjs).
export const LOCK_AFTER_MS = 60_000; // resume after > 60 s in the background (configurable later)

/** backgroundedAt <= 0 means cold start. */
export function shouldLock(enabled: boolean, backgroundedAt: number, now: number, lockAfterMs = LOCK_AFTER_MS): boolean {
  if (!enabled) return false;
  if (backgroundedAt <= 0) return true;
  return now - backgroundedAt > lockAfterMs;
}
