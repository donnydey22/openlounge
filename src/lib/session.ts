// Session token storage. The server issues an opaque token after phone verification
// and keeps only its hash (Postgres or data/db.json, 60-day sliding expiry).
//
// sessionStorage (per tab) takes priority over localStorage (shared), so you can be
// signed in as different people in different tabs of the same browser while testing.

const KEY = "openlounge:session";
/** Keys used before the rename to Open Lounge (Clubroom, then Lounge); read once and migrated so nobody gets signed out. */
const LEGACY_KEYS = ["lounge:session", "clubroom:session"];

export function loadToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let t = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
    if (!t) {
      for (const legacy of LEGACY_KEYS) {
        t = sessionStorage.getItem(legacy) ?? localStorage.getItem(legacy);
        if (t) break;
      }
      if (t) {
        localStorage.setItem(KEY, t);
        for (const legacy of LEGACY_KEYS) {
          localStorage.removeItem(legacy);
          sessionStorage.removeItem(legacy);
        }
      }
    }
    if (t) sessionStorage.setItem(KEY, t);
    return t;
  } catch {
    return null;
  }
}

export function saveToken(token: string) {
  sessionStorage.setItem(KEY, token);
  localStorage.setItem(KEY, token);
}

export function clearToken() {
  const mine = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  // only clear the shared copy if it's ours (another tab may have signed in as someone else)
  if (!mine || localStorage.getItem(KEY) === mine) localStorage.removeItem(KEY);
  // legacy demo identity from earlier versions
  localStorage.removeItem("clubroom:identity");
  sessionStorage.removeItem("clubroom:identity");
  for (const legacy of LEGACY_KEYS) {
    localStorage.removeItem(legacy);
    sessionStorage.removeItem(legacy);
  }
}
