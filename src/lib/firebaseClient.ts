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
  if (!document.getElementById(containerId)) {
    const el = document.createElement("div");
    el.id = containerId;
    document.body.appendChild(el); // lives outside React so step changes don't unmount it
  }
  if (!verifier) verifier = new RecaptchaVerifier(a, containerId, { size: "invisible" });
  try {
    return await signInWithPhoneNumber(a, e164, verifier);
  } catch (e) {
    verifier.clear();
    verifier = null;
    throw new Error(phoneError(e));
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
  const code = (e as { code?: string })?.code ?? "";
  if (code.includes("invalid-phone-number")) return "Enter a valid phone number";
  if (code.includes("too-many-requests") || code.includes("quota-exceeded")) return "Too many attempts. Try again later.";
  if (code.includes("invalid-verification-code")) return "That code doesn't match. Try again.";
  if (code.includes("code-expired")) return "That code expired. Request a new one.";
  if (code.includes("captcha")) return "Verification failed — please try again.";
  return "We couldn't verify that number. Try again.";
}
