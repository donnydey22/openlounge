// Native phone verification bridge. Inside the installed apps (Android WebView / iOS Expo WebView), phone sign-in
// runs through the native Firebase Auth SDK (Android: Play Integrity / SafetyNet-less; iOS: silent APNs), so users
// never see a web reCAPTCHA. The shell returns a Firebase ID token, which the web layer posts to the SAME server
// endpoint used after web Firebase verification (auth:verifyFirebase / linkPendingToPhone), so account matching is
// unchanged.
//
// Contract (all async; results come back through window.__olPhoneAuth(json)):
//   OpenLoungeNative.phoneAuthAvailable(): boolean | "true"          — feature flag
//   OpenLoungeNative.phoneAuthStart(reqId, e164)                     → {id, ok, sent?:true, idToken?, error?, code?}
//       idToken present = instant/auto verification (Android); sent = code SMS was sent
//   OpenLoungeNative.phoneAuthConfirm(reqId, code)                   → {id, ok, idToken?, error?, code?}
// iOS (react-native-webview) may instead expose only postMessage; the injected shim maps these calls to
//   postMessage(JSON.stringify({type:"phoneAuthStart"|"phoneAuthConfirm", id, phone|code})).

export interface NativePhoneResult {
  id: string;
  ok: boolean;
  sent?: boolean;
  idToken?: string;
  error?: string;
  code?: string;
}

interface Bridge {
  phoneAuthAvailable?: () => boolean | string;
  phoneAuthStart?: (id: string, e164: string) => void;
  phoneAuthConfirm?: (id: string, code: string) => void;
}

type W = Window & { OpenLoungeNative?: Bridge; __olPhoneAuth?: (json: string | NativePhoneResult) => void };

const pending = new Map<string, (r: NativePhoneResult) => void>();

function bridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  return (window as W).OpenLoungeNative ?? null;
}

export function hasNativePhoneAuth(): boolean {
  const b = bridge();
  if (!b || typeof b.phoneAuthStart !== "function" || typeof b.phoneAuthConfirm !== "function") return false;
  try {
    const v = b.phoneAuthAvailable?.();
    return v === undefined || v === true || v === "true";
  } catch {
    return false;
  }
}

function install() {
  const w = window as W;
  if (w.__olPhoneAuth) return;
  w.__olPhoneAuth = (json) => {
    let r: NativePhoneResult;
    try {
      r = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
      return;
    }
    const cb = pending.get(r?.id);
    if (cb) {
      pending.delete(r.id);
      cb(r);
    }
  };
}

function call(kind: "start" | "confirm", arg: string, timeoutMs: number): Promise<NativePhoneResult> {
  install();
  const b = bridge()!;
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Phone verification timed out. Please try again."));
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(t);
      resolve(r);
    });
    try {
      if (kind === "start") b.phoneAuthStart!(id, arg);
      else b.phoneAuthConfirm!(id, arg);
    } catch (e) {
      clearTimeout(t);
      pending.delete(id);
      reject(e);
    }
  });
}

/** Same shape the AuthFlow uses for web Firebase: confirm(code) → Firebase ID token. */
export interface PhoneSession {
  /** set when the platform verified the number without a code (Android instant verification) */
  instantToken?: string;
  confirm(code: string): Promise<string>;
}

export async function nativeSendPhoneCode(e164: string, mapError: (code: string) => string): Promise<PhoneSession> {
  const r = await call("start", e164, 120_000);
  if (!r.ok) throw new Error(r.error || mapError(r.code ?? ""));
  return {
    instantToken: r.idToken || undefined,
    async confirm(code: string) {
      if (r.idToken) return r.idToken;
      const c = await call("confirm", code, 60_000);
      if (!c.ok || !c.idToken) throw new Error(c.error || mapError(c.code ?? ""));
      return c.idToken;
    },
  };
}
