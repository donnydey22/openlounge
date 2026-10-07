// Contact matching, client side. Numbers and names never leave the device: we normalize to E.164 here and
// upload only SHA-256(E.164) hex digests. See docs/privacy-contacts.md.
import { COUNTRIES } from "@/components/auth/countries";
import { authFetch } from "./auth";
import type { PublicUser } from "./types";
import type { NativeContact } from "./native";

/** Best-effort E.164 normalization with the device's country as default. */
export function toE164(raw: string, country = "US"): string | null {
  const s = String(raw ?? "").trim();
  let digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith("00")) return toE164(`+${digits.slice(2)}`);
  const dial = (COUNTRIES.find((c) => c.code === country)?.dial ?? "+1").slice(1);
  if (dial === "1") {
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return digits.length === 10 ? `+1${digits}` : null;
  }
  digits = digits.replace(/^0+/, ""); // national trunk prefix
  const full = dial + digits;
  return full.length >= 8 && full.length <= 15 ? `+${full}` : null;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ContactEntry {
  name: string;
  e164: string;
  hash: string;
}

const yieldUI = () => new Promise<void>((r) => setTimeout(r, 0));

/** Normalize + dedupe + hash, in chunks so the UI stays responsive. onProgress gets 0..1. */
export async function prepareContacts(
  contacts: NativeContact[],
  country: string,
  onProgress?: (p: number) => void,
): Promise<ContactEntry[]> {
  const seen = new Map<string, string>(); // e164 -> name
  for (const c of contacts)
    for (const n of c.numbers ?? []) {
      const e164 = toE164(n, country);
      if (e164 && !seen.has(e164)) seen.set(e164, c.name || e164);
    }
  const list = [...seen].slice(0, MAX_CONTACT_NUMBERS);
  const out: ContactEntry[] = [];
  for (let i = 0; i < list.length; i += 250) {
    const chunk = list.slice(i, i + 250);
    const hashes = await Promise.all(chunk.map(([e164]) => sha256Hex(e164)));
    chunk.forEach(([e164, name], j) => out.push({ name, e164, hash: hashes[j] }));
    onProgress?.(out.length / list.length);
    await yieldUI();
  }
  return out;
}

export const MAX_CONTACT_NUMBERS = 20_000;
export const MATCH_BATCH = 500;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || "Something went wrong");
  return j as T;
}

type MatchResult = { users: PublicUser[]; matchedHashes: string[]; following: string[] };
const matchBatch = (hashes: string[], append: boolean) => postJson<MatchResult>("/api/contacts/match", { hashes, append });

/** Match in batches of MATCH_BATCH; the first batch replaces any previous upload, the rest append. */
export async function matchContacts(hashes: string[], onProgress?: (p: number) => void): Promise<MatchResult> {
  const users = new Map<string, PublicUser>();
  const matched = new Set<string>();
  let following: string[] = [];
  const n = Math.max(1, Math.ceil(hashes.length / MATCH_BATCH));
  for (let b = 0; b < n; b++) {
    const r = await matchBatch(hashes.slice(b * MATCH_BATCH, (b + 1) * MATCH_BATCH), b > 0);
    for (const u of r.users) users.set(u.id, u);
    r.matchedHashes.forEach((h) => matched.add(h));
    following = r.following;
    onProgress?.((b + 1) / n);
  }
  return { users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name)), matchedHashes: [...matched], following };
}
export const deleteUploadedContacts = () => postJson<{ ok: true }>("/api/contacts/delete", {});
