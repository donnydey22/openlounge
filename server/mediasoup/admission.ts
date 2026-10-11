import { createHmac, timingSafeEqual } from "node:crypto";

export interface MediasoupAdmissionClaims {
  v: 1;
  callId: string;
  userId: string;
  exp: number;
  nonce: string;
}

export type AdmissionCheck = { ok: true; claims: MediasoupAdmissionClaims } | { ok: false; reason: "malformed" | "signature" | "expired" | "claims" | "disabled" };

const MIN_SECRET_BYTES = 32;
const MAX_TTL_S = 10 * 60;
const MIN_TTL_S = 5;

export function usableAdmissionSecret(secret: string | undefined | null) {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES;
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function equal(a: string, b: string) {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/**
 * A compact, HMAC-authenticated token for the SFU control channel. It deliberately contains no TURN credential,
 * server address, display name, SDP, or other user-generated content.
 */
export function mintMediasoupAdmission(
  input: { callId: string; userId: string; nonce: string; ttlSec: number },
  opts: { secret?: string; nowMs?: number } = {},
): string | null {
  const secret = opts.secret ?? process.env.MEDIASOUP_ADMISSION_SECRET;
  if (!usableAdmissionSecret(secret)) return null;
  const signingSecret = secret as string;
  const ttlSec = Math.max(MIN_TTL_S, Math.min(MAX_TTL_S, Math.floor(input.ttlSec)));
  const claims: MediasoupAdmissionClaims = {
    v: 1,
    callId: input.callId,
    userId: input.userId,
    exp: Math.floor((opts.nowMs ?? Date.now()) / 1000) + ttlSec,
    nonce: input.nonce,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, signingSecret)}`;
}

export function verifyMediasoupAdmission(token: unknown, opts: { secret?: string; nowMs?: number } = {}): AdmissionCheck {
  const secret = opts.secret ?? process.env.MEDIASOUP_ADMISSION_SECRET;
  if (!usableAdmissionSecret(secret)) return { ok: false, reason: "disabled" };
  const signingSecret = secret as string;
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined || !equal(mac, sign(payload, signingSecret))) return { ok: false, reason: "signature" };
  let claims: MediasoupAdmissionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MediasoupAdmissionClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims?.v !== 1 ||
    typeof claims.callId !== "string" ||
    !/^[\w-]{1,64}$/.test(claims.callId) ||
    typeof claims.userId !== "string" ||
    !/^[\w:.@-]{1,128}$/.test(claims.userId) ||
    typeof claims.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(claims.nonce) ||
    !Number.isFinite(claims.exp)
  )
    return { ok: false, reason: "claims" };
  if (claims.exp <= Math.floor((opts.nowMs ?? Date.now()) / 1000)) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
