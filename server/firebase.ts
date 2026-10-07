// Firebase Admin (phone-auth ID token verification + FCM HTTP v1). Enabled only when FIREBASE_SERVICE_ACCOUNT_JSON
// (raw JSON or base64 of it) is set. The key is never logged.
import type { App } from "firebase-admin/app";

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let text = s;
  if (!s.startsWith("{")) {
    try {
      text = Buffer.from(s, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const j = JSON.parse(text);
    if (typeof j.project_id === "string" && typeof j.client_email === "string" && typeof j.private_key === "string") return j;
  } catch {
    /* fallthrough */
  }
  return null;
}

let app: App | null | undefined;

export async function firebaseApp(): Promise<App | null> {
  if (app !== undefined) return app;
  const sa = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!sa) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) console.warn("[firebase] FIREBASE_SERVICE_ACCOUNT_JSON is set but not a valid service account (raw JSON or base64)");
    return (app = null);
  }
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  app = getApps()[0] ?? initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }), projectId: sa.project_id });
  console.log(`[firebase] admin ready (project ${sa.project_id})`);
  return app;
}

export const firebaseConfigured = () => !!parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

/** Demo OTP (000000 / on-screen codes) stays on unless DEMO_OTP_ENABLED is explicitly false/0/off. */
export const demoOtpEnabled = () => !/^(0|false|off|no)$/i.test(process.env.DEMO_OTP_ENABLED ?? "true");

export type PhoneVerifier = (idToken: string) => Promise<{ ok: true; phone: string; uid: string } | { ok: false; error: string }>;

let verifierOverride: PhoneVerifier | null = null;
/** tests inject a fake verifier */
export function setPhoneVerifier(v: PhoneVerifier | null) {
  verifierOverride = v;
}

export const verifyPhoneIdToken: PhoneVerifier = async (idToken) => {
  if (verifierOverride) return verifierOverride(idToken);
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 8000) return { ok: false, error: "Invalid sign-in token" };
  const a = await firebaseApp();
  if (!a) return { ok: false, error: "Phone sign-in isn't configured on this server" };
  try {
    const { getAuth } = await import("firebase-admin/auth");
    const t = await getAuth(a).verifyIdToken(idToken, true);
    if (t.firebase?.sign_in_provider !== "phone" || !t.phone_number) return { ok: false, error: "That sign-in isn't a verified phone number" };
    return { ok: true, phone: t.phone_number, uid: t.uid };
  } catch (err) {
    console.warn("[firebase] ID token rejected:", (err as { code?: string }).code ?? (err as Error).message);
    return { ok: false, error: "Your verification expired — please try again." };
  }
};
