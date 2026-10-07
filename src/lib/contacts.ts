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

export async function prepareContacts(contacts: NativeContact[], country: string): Promise<ContactEntry[]> {
  const seen = new Map<string, ContactEntry>();
  for (const c of contacts)
    for (const n of c.numbers ?? []) {
      const e164 = toE164(n, country);
      if (e164 && !seen.has(e164)) seen.set(e164, { name: c.name || e164, e164, hash: await sha256Hex(e164) });
    }
  return [...seen.values()].slice(0, 5000);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || "Something went wrong");
  return j as T;
}

export const matchContacts = (hashes: string[]) =>
  postJson<{ users: PublicUser[]; matchedHashes: string[]; following: string[] }>("/api/contacts/match", { hashes });
export const deleteUploadedContacts = () => postJson<{ ok: true }>("/api/contacts/delete", {});
