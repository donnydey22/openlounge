// App Lock helpers. Lock state lives in realtime.ts (appLocked / setAppLocked / NATIVE_LOCK_EVENT).
export { NATIVE_LOCK_EVENT, setAppLocked, appLocked } from "@/lib/realtime";

/** No-op installer: importing this module ensures realtime's NATIVE_LOCK_EVENT listener is registered. */
export function installAppLockPresence() {
  return () => {};
}

/** Pure helper (unit-tested): a call deep-link that should bypass App Lock. */
export function isCallAcceptPath(path: string | null | undefined): boolean {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/call/")) return false;
  if (path.includes("accept=1")) return true;
  // bare /call/<id> from a notification tap still needs the lock cleared so the ring UI is reachable
  return /^\/call\/[^/?#]+/.test(path);
}
