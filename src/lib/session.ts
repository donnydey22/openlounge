// The one session module: where the client keeps its credentials (web, Android WebView shell, iOS wrapper).
//
// Keys (localStorage = durable + shared by tabs; sessionStorage = per tab, takes priority so testers can be
// different people in different tabs):
//   openlounge:session  long-lived refresh token (pre-v2 this held the one-and-only session token — such a
//                       "legacy" token is still accepted by the server and is exchanged on the first refresh)
//   openlounge:access   {"t": access token, "exp": epoch ms}   (short-lived, 1 h)
//   openlounge:uid      user id the credentials belong to
//   openlounge:saved    epoch ms of the last write (decides which copy is newer: web storage vs native store)
//
// ─── Native token store contract (Android WebView shell, iOS Expo/EAS wrapper, any future shell) ──────────────
// If the page finds `window.OpenLoungeNative`, it is used as the durable token store, in addition to
// localStorage. It survives app kills, WebView storage eviction and origin changes (openlounge.app vs
// *.up.railway.app have separate localStorage). Shape:
//
//   window.OpenLoungeNative = {
//     getSession():            string | null  | Promise<string | null>
//     setSession(value: string): void        | Promise<void>
//     clearSession():          void           | Promise<void>
//   }
//
//   • Every method may be synchronous (Android @JavascriptInterface) or return a Promise (iOS: Keychain via
//     expo-secure-store behind a postMessage round trip). The web side always awaits; a method that throws or
//     rejects is treated as "no native store" for that call — it never signs anyone out.
//   • `value` is an opaque string. Today it is JSON:
//       {"v":1,"refresh":"…","access":"…"|null,"accessExp":<ms>,"uid":"u_…"|null,"savedAt":<ms>}
//     Shells must store and return it verbatim (no parsing needed). getSession() may also return a bare legacy
//     token string (pre-v2 shells) — it is accepted as a refresh token.
//   • setSession is called after every sign-in and every refresh-token rotation (the refresh token rotates, so a
//     shell must persist each new value synchronously/durably — e.g. SharedPreferences.commit(), Keychain);
//     clearSession on sign-out / when the server definitively rejects the session.
//   • The object must exist before the page's scripts run (Android: addJavascriptInterface before loadUrl;
//     iOS/react-native-webview: injectedJavaScriptBeforeContentLoaded).
//   • Optional: openAuth(url: string): void | Promise<void> — Google / Apple sign-in. Google refuses OAuth inside
//     embedded WebViews, so the shell must open `url` in the system browser (Android Custom Tab, iOS
//     ASWebAuthenticationSession / expo-web-browser openAuthSessionAsync), catch the return deep link
//     openlounge://auth?code=…|error=…, and load https://openlounge.app/auth/complete?<same query> in the WebView.
//     Without openAuth the Google/Apple buttons are hidden inside the shell. See docs/unified-auth.md.
//   • On launch the web app calls hydrateFromNative() before deciding signed-in vs sign-in screen: the newer of
//     {native copy, web storage copy} wins (by savedAt), and the other one is brought up to date.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const KEY = "openlounge:session";
const ACCESS_KEY = "openlounge:access";
const UID_KEY = "openlounge:uid";
const SAVED_KEY = "openlounge:saved";
/** Keys used before the rename to Open Lounge (Clubroom, then Lounge); read once and migrated so nobody gets signed out. */
const LEGACY_KEYS = ["lounge:session", "clubroom:session"];

export interface Creds {
  refresh: string;
  access: string | null;
  accessExp: number;
  uid: string | null;
  /** last write (ms); 0 = unknown (legacy) */
  savedAt?: number;
}

export interface NativeSessionStore {
  getSession(): string | null | undefined | Promise<string | null | undefined>;
  setSession(value: string): void | Promise<void>;
  clearSession(): void | Promise<void>;
}

function nativeStore(): NativeSessionStore | null {
  if (typeof window === "undefined") return null;
  const n = (window as unknown as { OpenLoungeNative?: Partial<NativeSessionStore> }).OpenLoungeNative;
  return n && typeof n.getSession === "function" && typeof n.setSession === "function" ? (n as NativeSessionStore) : null;
}

/** True inside a native shell that provides the token store. */
export const hasNativeStore = () => !!nativeStore();

const get = (st: Storage, k: string) => {
  try {
    return st.getItem(k);
  } catch {
    return null;
  }
};
const set = (st: Storage, k: string, v: string | null) => {
  try {
    if (v === null) st.removeItem(k);
    else st.setItem(k, v);
  } catch {
    /* storage full / disabled (private mode) */
  }
};

function parseAccess(raw: string | null): { t: string; exp: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { t?: unknown; exp?: unknown };
    if (typeof v.t === "string" && typeof v.exp === "number") return { t: v.t, exp: v.exp };
  } catch {
    /* ignore */
  }
  return null;
}

function read(st: Storage): Creds | null {
  const refresh = get(st, KEY);
  if (!refresh) return null;
  const a = parseAccess(get(st, ACCESS_KEY));
  return { refresh, access: a?.t ?? null, accessExp: a?.exp ?? 0, uid: get(st, UID_KEY), savedAt: Number(get(st, SAVED_KEY)) || 0 };
}

function writeTo(st: Storage, c: Creds) {
  set(st, KEY, c.refresh);
  set(st, ACCESS_KEY, c.access ? JSON.stringify({ t: c.access, exp: c.accessExp }) : null);
  set(st, UID_KEY, c.uid);
  set(st, SAVED_KEY, c.savedAt ? String(c.savedAt) : null);
}

function wipe(st: Storage) {
  for (const k of [KEY, ACCESS_KEY, UID_KEY, SAVED_KEY]) set(st, k, null);
}

// ---------- native store ----------

/** Serialize for the native store. */
export function encodeNative(c: Creds): string {
  return JSON.stringify({ v: 1, refresh: c.refresh, access: c.access, accessExp: c.accessExp, uid: c.uid, savedAt: c.savedAt ?? 0 });
}

/** Parse what a native store returned (JSON v1, or a bare legacy token). */
export function decodeNative(raw: unknown): Creds | null {
  if (typeof raw !== "string" || raw.length < 20) return null;
  const s = raw.trim();
  if (s.startsWith("{")) {
    try {
      const v = JSON.parse(s) as Partial<Creds> & { v?: number; parked?: boolean };
      if (v.parked) return null; // a "quick sign-in" copy kept behind App lock: never an automatic sign-in
      if (typeof v.refresh !== "string" || v.refresh.length < 20) return null;
      return {
        refresh: v.refresh,
        access: typeof v.access === "string" ? v.access : null,
        accessExp: Number(v.accessExp) || 0,
        uid: typeof v.uid === "string" ? v.uid : null,
        savedAt: Number(v.savedAt) || 0,
      };
    } catch {
      return null;
    }
  }
  return /^[\w-]+$/.test(s) ? { refresh: s, access: null, accessExp: 0, uid: null, savedAt: 0 } : null;
}

let nativeChain: Promise<unknown> = Promise.resolve();
/** Writes to the native store are serialized so an older value can never land after a newer one. */
function toNative(c: Creds | null) {
  const n = nativeStore();
  if (!n) return;
  nativeChain = nativeChain
    .then(() => (c ? n.setSession(encodeNative(c)) : n.clearSession?.()))
    .catch(() => {
      /* shell refused / bridge gone: web storage still has it */
    });
}

async function readNative(timeoutMs = 2500): Promise<Creds | null> {
  const n = nativeStore();
  if (!n) return null;
  try {
    const raw = await Promise.race([Promise.resolve(n.getSession()), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    return decodeNative(raw);
  } catch {
    return null;
  }
}

/**
 * Launch step, before deciding signed-in vs signed-out: reconcile the native store with web storage.
 * The newer copy wins (savedAt); with no native shell this only migrates legacy keys. Never throws.
 */
export async function hydrateFromNative(): Promise<Creds | null> {
  if (typeof window === "undefined") return null;
  const web = loadCreds();
  if (!nativeStore()) return web;
  const nat = await readNative();
  if (nat && (!web || (nat.refresh !== web.refresh && (nat.savedAt ?? 0) > (web.savedAt ?? 0)))) {
    // native is newer (or web storage was evicted / this is a different origin): adopt it
    writeTo(localStorage, nat);
    writeTo(sessionStorage, nat);
    return nat;
  }
  if (web && (!nat || nat.refresh !== web.refresh || nat.access !== web.access)) toNative(web.savedAt ? web : { ...web, savedAt: Date.now() });
  return web;
}

// ---------- web storage (sync) ----------

/** This tab's credentials (sessionStorage → localStorage → legacy keys), or null. */
export function loadCreds(): Creds | null {
  if (typeof window === "undefined") return null;
  let c = read(sessionStorage) ?? read(localStorage);
  if (!c) {
    let legacy: string | null = null;
    for (const k of LEGACY_KEYS) {
      legacy = get(sessionStorage, k) ?? get(localStorage, k);
      if (legacy) break;
    }
    if (legacy) {
      c = { refresh: legacy, access: null, accessExp: 0, uid: null, savedAt: 0 };
      writeTo(localStorage, c);
      for (const k of LEGACY_KEYS) {
        set(localStorage, k, null);
        set(sessionStorage, k, null);
      }
    }
  }
  if (c) writeTo(sessionStorage, c);
  return c;
}

/** The shared (localStorage) copy — another tab may have rotated the tokens. */
export function loadSharedCreds(): Creds | null {
  if (typeof window === "undefined") return null;
  return read(localStorage);
}

// "Keep me signed in on this device" (default on). Off = this tab only: no localStorage / native store / cookie copy.
const KEEP_KEY = "openlounge:keep";
export function keepSignedIn(): boolean {
  if (typeof window === "undefined") return true;
  return get(sessionStorage, KEEP_KEY) !== "0";
}
export function setKeepSignedIn(on: boolean) {
  if (typeof window === "undefined") return;
  set(sessionStorage, KEEP_KEY, on ? null : "0");
}

export function saveCreds(c: Creds) {
  const stamped = { ...c, savedAt: Date.now() };
  writeTo(sessionStorage, stamped);
  if (!keepSignedIn()) return;
  writeTo(localStorage, stamped);
  toNative(stamped);
}

/** The long-lived token of this tab (null = signed out on this device). */
export function loadToken(): string | null {
  return loadCreds()?.refresh ?? null;
}

/** Forget the session on this device (web storage + native store). */
export function clearToken() {
  if (typeof window === "undefined") return;
  const mine = get(sessionStorage, KEY);
  wipe(sessionStorage);
  // only clear the shared copy if it's ours (another tab may have signed in as someone else)
  if (!mine || get(localStorage, KEY) === mine) {
    wipe(localStorage);
    if (keepParked) keepParked = false; // parkSession just wrote the parked copy: leave it
    else toNative(null);
  }
  // legacy demo identity from earlier versions
  set(localStorage, "clubroom:identity", null);
  set(sessionStorage, "clubroom:identity", null);
  for (const legacy of LEGACY_KEYS) {
    set(localStorage, legacy, null);
    set(sessionStorage, legacy, null);
  }
}

// ---------- quick sign-in (App lock on: screen name + Face ID / fingerprint) ----------
//
// When someone signs out while App lock is on, the session is "parked" in the native encrypted store (Android
// Keystore / iOS Keychain) instead of being thrown away: {"v":1,"parked":true,"username":"…",…creds}. A parked copy
// is never adopted on launch (decodeNative ignores it), so the app really is signed out. On the sign-in screen,
// typing that screen name offers "Sign in with Face ID / fingerprint": after a successful OS prompt the copy is
// un-parked and the page reloads signed in. The refresh token is still validated (and rotated) by the server, so a
// revoked / expired parked session simply fails and falls back to the password. Shells need no changes: it is the
// same opaque getSession/setSession string.

let keepParked = false;

export interface ParkedSession {
  username: string;
  name: string | null;
}

export function encodeParked(c: Creds, username: string, name: string | null): string {
  return JSON.stringify({ v: 1, parked: true, username, name, refresh: c.refresh, access: null, accessExp: 0, uid: c.uid, savedAt: Date.now() });
}

export function decodeParked(raw: unknown): (ParkedSession & { creds: Creds }) | null {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null;
  try {
    const v = JSON.parse(raw) as { parked?: boolean; username?: unknown; name?: unknown; refresh?: unknown; uid?: unknown };
    if (v.parked !== true || typeof v.username !== "string" || !v.username || typeof v.refresh !== "string" || v.refresh.length < 20) return null;
    return {
      username: v.username,
      name: typeof v.name === "string" ? v.name : null,
      creds: { refresh: v.refresh, access: null, accessExp: 0, uid: typeof v.uid === "string" ? v.uid : null, savedAt: Date.now() },
    };
  } catch {
    return null;
  }
}

/** Sign out locally but keep the session parked in the native store (call only when App lock is on). */
export async function parkSession(username: string, name: string | null): Promise<boolean> {
  const n = nativeStore();
  const c = loadCreds();
  if (!n || !c) return false;
  try {
    const r = await fetch("/api/auth/forget-cookie", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) return false;
  } catch {
    return false; // offline: fall back to a normal sign-out
  }
  keepParked = true;
  wipe(sessionStorage);
  wipe(localStorage);
  try {
    await nativeChain;
    await n.setSession(encodeParked(c, username, name));
    return true;
  } catch {
    keepParked = false;
    saveCreds(c); // couldn't park: put the session back so the normal sign-out revokes it
    return false;
  }
}

export async function readParked(): Promise<ParkedSession | null> {
  const n = nativeStore();
  if (!n) return null;
  try {
    const p = decodeParked(await Promise.race([Promise.resolve(n.getSession()), new Promise<null>((r) => setTimeout(() => r(null), 2500))]));
    return p ? { username: p.username, name: p.name } : null;
  } catch {
    return null;
  }
}

/** After a successful biometric prompt: restore the parked session as the live one. */
export async function unparkSession(): Promise<Creds | null> {
  const n = nativeStore();
  if (!n) return null;
  try {
    const p = decodeParked(await n.getSession());
    if (!p) return null;
    saveCreds(p.creds);
    await nativeChain;
    return p.creds;
  } catch {
    return null;
  }
}

/** "Not you?" / forget this device: drop the parked copy. */
export async function forgetParked() {
  const n = nativeStore();
  if (!n) return;
  try {
    if (decodeParked(await n.getSession())) await n.clearSession();
  } catch {
    /* ignore */
  }
}
