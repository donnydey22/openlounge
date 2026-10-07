// Password hashing for email accounts: scrypt (node:crypto, no native deps).
// Stored as "scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>" so parameters can be raised later
// (verify reads them from the hash; needsRehash tells the caller to upgrade on next login).

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 1 << 15; // 32768
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2; // scrypt needs 128*N*r bytes; leave headroom

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Friendly problem with a new password, or null if it's acceptable. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!pw.trim()) return "Your password can't be only spaces.";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time verify. Malformed/missing hashes verify as false (after doing comparable work). */
export async function verifyPassword(password: unknown, stored: string | null | undefined): Promise<boolean> {
  const pw = typeof password === "string" ? password.slice(0, PASSWORD_MAX) : "";
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    await dummyVerify(pw);
    return false;
  }
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64url");
  const nn = Number(n), rr = Number(r), pp = Number(p);
  if (!expected.length || !Number.isInteger(nn) || nn > 1 << 20 || !Number.isInteger(rr) || !Number.isInteger(pp)) return false;
  const key = await scrypt(pw, Buffer.from(saltB64, "base64url"), expected.length, { N: nn, r: rr, p: pp, maxmem: 128 * nn * rr * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const needsRehash = (stored: string) => !stored.startsWith(`scrypt$${N}$${R}$${P}$`);

let dummy: Promise<string> | null = null;
/** Same cost as a real verify — used when the email isn't registered (no timing oracle for account enumeration). */
export async function dummyVerify(password: string) {
  dummy ??= hashPassword("openlounge-dummy-password");
  await verifyPassword(password || "x", await dummy).catch(() => false);
}
