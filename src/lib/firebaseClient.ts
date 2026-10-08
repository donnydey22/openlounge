// Firebase JS SDK (web): phone auth with an invisible reCAPTCHA. Loaded lazily — only when the server says
// Firebase phone auth is on (auth:config). The web config is public by design.
import type { ConfirmationResult, RecaptchaVerifier } from "firebase/auth";
import { hasNativePhoneAuth, nativeSendPhoneCode, type PhoneSession } from "./nativePhone";
export type { PhoneSession } from "./nativePhone";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyBYGoBfnu03JtFgqSd8G5iOgHF3RC3wvU0",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "open-lounge-2aabd.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "open-lounge-2aabd",
  storageBucket: "open-lounge-2aabd.firebasestorage.app",
  messagingSenderId: "166652417209",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:166652417209:web:2191ef9e07e55dc89c3768",
};

let verifier: RecaptchaVerifier | null = null;

async function auth() {
  const { initializeApp, getApps } = await import("firebase/app");
  const { getAuth } = await import("firebase/auth");
  const app = getApps()[0] ?? initializeApp(config);
  const a = getAuth(app);
  a.useDeviceLanguage();
  // reCAPTCHA Enterprise (score-based, no visual challenge): when the project's phone recaptchaConfig is AUDIT/ENFORCE,
  // the SDK (v11+) uses it automatically. Pre-loading the config avoids an extra round-trip on send; if it fails
  // (Enterprise not configured) we silently stay on the classic invisible reCAPTCHA v2 path.
  if (!recaptchaConfigLoaded) {
    recaptchaConfigLoaded = true;
    try {
      const { initializeRecaptchaConfig } = await import("firebase/auth");
      await initializeRecaptchaConfig(a);
    } catch {
      /* Enterprise not enabled → v2 invisible fallback */
    }
  }
  return a;
}
let recaptchaConfigLoaded = false;

/** Warm-up on the sign-in screens: load the SDK, init auth + reCAPTCHA config so "Continue" sends instantly. */
export async function warmPhoneAuth(): Promise<void> {
  if (hasNativePhoneAuth()) return;
  try {
    await auth();
    await import("firebase/auth");
  } catch {
    /* best effort */
  }
}

/** Sends the SMS. `containerId` is an (empty) element id for the invisible reCAPTCHA. */
export async function sendPhoneCode(e164: string, containerId: string): Promise<PhoneSession> {
  // Installed apps: native Firebase phone auth (Play Integrity / silent APNs) — no web reCAPTCHA at all.
  if (hasNativePhoneAuth()) return nativeSendPhoneCode(e164, codeMessage);
  return wrap(await sendWebPhoneCode(e164, containerId));
}

function wrap(c: ConfirmationResult): PhoneSession {
  return { confirm: (code) => confirmWeb(c, code) };
}

async function sendWebPhoneCode(e164: string, containerId: string): Promise<ConfirmationResult> {
  const a = await auth();
  const { RecaptchaVerifier, signInWithPhoneNumber } = await import("firebase/auth");
  // The invisible reCAPTCHA container (and Google's challenge popup) must live directly under <body>, outside any
  // transformed / overflow-hidden / modal layer, or the image challenge renders clipped or behind app overlays.
  const hostId = `ol-recaptcha-${containerId}`;
  let host = document.getElementById(hostId);
  if (!host || host.parentElement !== document.body) {
    host?.remove();
    host = document.createElement("div");
    host.id = hostId;
    host.className = "ol-recaptcha-host";
    document.body.appendChild(host); // lives outside React so step changes don't unmount it
  }
  if (!verifier) verifier = new RecaptchaVerifier(a, hostId, { size: "invisible" });
  // unlock page scroll (modal scroll-lock) while a challenge may be shown
  document.documentElement.classList.add("ol-recaptcha-active");
  try {
    return await signInWithPhoneNumber(a, e164, verifier);
  } catch (e) {
    try {
      verifier?.clear();
    } catch {
      /* reset by resetPhoneVerifier */
    }
    verifier = null;
    throw new Error(phoneError(e));
  } finally {
    document.documentElement.classList.remove("ol-recaptcha-active");
  }
}

/** Abandon a pending web send (they chose email instead): drop the verifier and any open reCAPTCHA challenge. */
export function resetPhoneVerifier() {
  try {
    verifier?.clear();
  } catch {
    /* already gone */
  }
  verifier = null;
  document.querySelectorAll(".ol-recaptcha-host").forEach((el) => el.remove());
  // Google appends the challenge popup (bframe) straight to <body>, outside our host
  document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"],iframe[src*="recaptcha/enterprise/bframe"]').forEach((f) => f.closest("body > div")?.remove());
  document.documentElement.classList.remove("ol-recaptcha-active");
}

/** Confirms the 6-digit code; returns a Firebase ID token for the server (then signs out of Firebase locally). */
export function confirmPhoneCode(s: PhoneSession, code: string): Promise<string> {
  return s.confirm(code);
}

async function confirmWeb(c: ConfirmationResult, code: string): Promise<string> {
  try {
    const cred = await c.confirm(code);
    const token = await cred.user.getIdToken();
    void (await auth()).signOut(); // our own session takes over; Firebase is only the verifier
    return token;
  } catch (e) {
    throw new Error(phoneError(e));
  }
}

function phoneError(e: unknown): string {
  console.error(e);
  return codeMessage((e as { code?: string })?.code ?? "");
}

function codeMessage(code: string): string {
  if (code.includes("billing-not-enabled")) return "Phone sign-in is temporarily unavailable. Please try again soon.";
  if (code.includes("unauthorized-domain")) return "Phone sign-in isn't enabled for this site yet. Please try again soon.";
  if (code.includes("invalid-app-credential")) return "We couldn't verify this device. Refresh the page and try again.";
  if (code.includes("operation-not-allowed")) return "Phone sign-in is currently disabled. Please try another sign-in method.";
  if (code.includes("quota-exceeded")) return "We've hit our SMS limit for now. Please try again later.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait a bit and try again.";
  if (code.includes("invalid-phone-number")) return "Enter a valid phone number";
  if (code.includes("invalid-verification-code")) return "That code doesn't match. Try again.";
  if (code.includes("code-expired")) return "That code expired. Request a new one.";
  if (code.includes("captcha")) return "Verification failed — please try again.";
  return `We couldn't verify that number (${code || "unknown"}).`;
}
