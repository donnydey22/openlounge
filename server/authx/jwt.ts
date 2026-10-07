// Minimal JOSE helpers on node:crypto: verify provider ID tokens (RS256 / ES256) against a JWKS,
// and sign the Sign in with Apple client secret (ES256). No third-party JWT library.

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type JsonWebKey, type KeyObject } from "node:crypto";

export const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } | null {
  if (typeof token !== "string" || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], "base64url"),
    };
  } catch {
    return null;
  }
}

// ---------- JWKS (cached per URL; refetched on an unknown kid, at most every 30 s) ----------

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
const jwksCache = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60_000;

async function fetchJwks(url: string) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, KeyObject>();
  for (const k of body.keys ?? []) {
    if (!k.kid) continue;
    try {
      keys.set(k.kid, createPublicKey({ key: k, format: "jwk" }));
    } catch {
      /* unsupported key type: skip */
    }
  }
  const entry = { keys, fetchedAt: Date.now() };
  jwksCache.set(url, entry);
  return entry;
}

async function keyFor(url: string, kid: string): Promise<KeyObject | null> {
  let entry = jwksCache.get(url);
  if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS) entry = await fetchJwks(url);
  let key = entry.keys.get(kid);
  if (!key && Date.now() - entry.fetchedAt > 30_000) key = (await fetchJwks(url)).keys.get(kid);
  return key ?? null;
}

/** test helper */
export function clearJwksCache() {
  jwksCache.clear();
}

export interface VerifyOpts {
  jwksUrl: string;
  issuers: string[];
  audience: string;
  /** when set, the token's nonce claim must equal it */
  nonce?: string;
  /** allowed clock skew (s) */
  skewSec?: number;
}

export type IdTokenClaims = Record<string, unknown> & { sub: string; iss: string; aud: string | string[]; exp: number };

/** Verify signature (RS256/ES256 via JWKS), iss, aud, exp/iat/nbf and nonce. Throws Error("id_token: …") on failure. */
export async function verifyIdToken(token: string, opts: VerifyOpts): Promise<IdTokenClaims> {
  const d = decodeJwt(token);
  if (!d) throw new Error("id_token: malformed");
  const alg = d.header.alg;
  const kid = d.header.kid;
  if ((alg !== "RS256" && alg !== "ES256") || typeof kid !== "string") throw new Error("id_token: unsupported alg/kid");
  const key = await keyFor(opts.jwksUrl, kid);
  if (!key) throw new Error("id_token: unknown kid");
  const ok =
    alg === "RS256"
      ? cryptoVerify("RSA-SHA256", Buffer.from(d.signingInput), key, d.signature)
      : cryptoVerify("SHA256", Buffer.from(d.signingInput), { key, dsaEncoding: "ieee-p1363" }, d.signature);
  if (!ok) throw new Error("id_token: bad signature");
  const c = d.payload as IdTokenClaims;
  const now = Math.floor(Date.now() / 1000);
  const skew = opts.skewSec ?? 60;
  if (!opts.issuers.includes(String(c.iss))) throw new Error("id_token: wrong issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.audience)) throw new Error("id_token: wrong audience");
  if (typeof c.exp !== "number" || c.exp + skew < now) throw new Error("id_token: expired");
  if (typeof c.iat === "number" && c.iat - skew > now) throw new Error("id_token: issued in the future");
  if (typeof c.nbf === "number" && c.nbf - skew > now) throw new Error("id_token: not yet valid");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("id_token: no subject");
  if (opts.nonce !== undefined && c.nonce !== opts.nonce) throw new Error("id_token: nonce mismatch");
  return c;
}

/** Providers send booleans or "true"/"false" strings (Apple). */
export const claimTrue = (v: unknown) => v === true || v === "true";

/** Parse a PKCS#8 PEM (.p8). Accepts literal "\n" escapes (env vars) or a bare base64 body. */
export function parseP8(raw: string): KeyObject {
  let pem = raw.trim().replace(/\\n/g, "\n");
  if (!pem.includes("BEGIN")) pem = `-----BEGIN PRIVATE KEY-----\n${pem.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
  return createPrivateKey({ key: pem, format: "pem" });
}

/** Compact JWS with ES256 (P-256), raw r||s signature as JOSE requires. */
export function signEs256(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const input = `${b64url(JSON.stringify({ ...header, alg: "ES256" }))}.${b64url(JSON.stringify(payload))}`;
  const sig = cryptoSign("SHA256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}
