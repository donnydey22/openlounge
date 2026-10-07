// Firebase JS SDK (web): phone auth with an invisible reCAPTCHA. Loaded lazily — only when the server says
// Firebase phone auth is on (auth:config). The web config is public by design.
import type { ConfirmationResult, RecaptchaVerifier } from "firebase/auth";

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
  return a;
}

/** Sends the SMS. `containerId` is an (empty) element id for the invisible reCAPTCHA. */
export async function sendPhoneCode(e164: string, containerId: string): Promise<ConfirmationResult> {
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
    verifier.clear();
    verifier = null;
    throw new Error(phoneError(e));
  } finally {
    document.documentElement.classList.remove("ol-recaptcha-active");
  }
}

/** Confirms the 6-digit code; returns a Firebase ID token for the server (then signs out of Firebase locally). */
export async function confirmPhoneCode(c: ConfirmationResult, code: string): Promise<string> {
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
  const code = (e as { code?: string })?.code ?? "";
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
