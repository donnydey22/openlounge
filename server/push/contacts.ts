// Contact matching (opt-in). Clients normalize numbers to E.164 and send SHA-256(E.164) hex only.
// The server never sees raw numbers from address books; it stores HMAC-SHA256(pepper, clientHash) and only
// for UNMATCHED_HASH_TTL_MS (24 h) — see docs/privacy-contacts.md.
import { createHash, createHmac, randomBytes } from "node:crypto";

let pepper: string | null = null;
export function contactsPepper() {
  if (!pepper) {
    pepper = process.env.CONTACTS_PEPPER || "";
    if (!pepper) {
      pepper = randomBytes(32).toString("hex");
      console.warn("[contacts] CONTACTS_PEPPER not set — using a per-process pepper (stored hashes won't match after a restart)");
    }
  }
  return pepper;
}
export function setContactsPepper(p: string) {
  pepper = p;
}

/** what a client sends for a number */
export const clientHash = (e164: string) => createHash("sha256").update(e164).digest("hex");
/** what we store / compare */
export const pepperHash = (clientHex: string) => createHmac("sha256", contactsPepper()).update(clientHex.toLowerCase()).digest("hex");

export const MAX_CONTACTS = 5000; // per request (clients batch ~500)
export const MAX_MATCH_REQUESTS_PER_WINDOW = 60; // per user
export const MATCH_WINDOW_MS = 10 * 60_000;
const matchHits = new Map<string, number[]>();
/** bounded per-user rate limit for /api/contacts/match */
export function allowMatch(userId: string, now = Date.now()): boolean {
  const arr = (matchHits.get(userId) ?? []).filter((t) => now - t < MATCH_WINDOW_MS);
  if (arr.length >= MAX_MATCH_REQUESTS_PER_WINDOW) return (matchHits.set(userId, arr), false);
  arr.push(now);
  matchHits.set(userId, arr);
  if (matchHits.size > 10_000) for (const k of matchHits.keys()) { matchHits.delete(k); break; }
  return true;
}
export function cleanHashes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CONTACTS) return null;
  const out = new Set<string>();
  for (const h of raw) if (typeof h === "string" && /^[0-9a-f]{64}$/i.test(h)) out.add(h.toLowerCase());
  return [...out];
}
