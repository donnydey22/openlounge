// Social links: shared (client + server) normalization/validation. Users type a handle or a URL;
// we store only canonical https URLs. Unknown keys are dropped; "" clears a field.

export const SOCIAL_KEYS = ["instagram", "x", "tiktok", "youtube", "linkedin", "snapchat", "telegram", "threads", "website"] as const;
export type SocialKey = (typeof SOCIAL_KEYS)[number];
export type SocialLinks = Partial<Record<SocialKey, string>>;

export const SOCIAL_INPUT_MAX = 200;
export const WEBSITE_MAX = 200;

interface Spec {
  label: string;
  placeholder: string;
  hosts: string[];
  /** handle charset + length */
  re: RegExp;
  /** pull the handle out of a URL path (already split, no empty parts) */
  fromPath: (parts: string[]) => string | null;
  url: (h: string) => string;
}

const first = (parts: string[]) => parts[0] ?? null;
const at = (s: string | null) => (s && s.startsWith("@") ? s.slice(1) : null);

export const SOCIAL_SPECS: Record<Exclude<SocialKey, "website">, Spec> = {
  instagram: { label: "Instagram", placeholder: "@handle or instagram.com/handle", hosts: ["instagram.com"], re: /^(?!.*\.\.)(?!\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/, fromPath: first, url: (h) => `https://instagram.com/${h}` },
  x: { label: "X (Twitter)", placeholder: "@handle or x.com/handle", hosts: ["x.com", "twitter.com"], re: /^[A-Za-z0-9_]{1,15}$/, fromPath: first, url: (h) => `https://x.com/${h}` },
  tiktok: { label: "TikTok", placeholder: "@handle or tiktok.com/@handle", hosts: ["tiktok.com"], re: /^(?!.*\.$)[A-Za-z0-9._]{2,24}$/, fromPath: (p) => at(first(p)) ?? first(p), url: (h) => `https://www.tiktok.com/@${h}` },
  youtube: { label: "YouTube", placeholder: "@handle or youtube.com/@handle", hosts: ["youtube.com"], re: /^[A-Za-z0-9._-]{3,30}$/, fromPath: (p) => at(first(p)), url: (h) => `https://www.youtube.com/@${h}` },
  linkedin: { label: "LinkedIn", placeholder: "handle or linkedin.com/in/handle", hosts: ["linkedin.com"], re: /^[A-Za-z0-9-]{3,100}$/, fromPath: (p) => (p[0] === "in" ? p[1] ?? null : null), url: (h) => `https://www.linkedin.com/in/${h}` },
  snapchat: { label: "Snapchat", placeholder: "username or snapchat.com/add/username", hosts: ["snapchat.com"], re: /^[A-Za-z][A-Za-z0-9._-]{1,14}$/, fromPath: (p) => (p[0] === "add" ? p[1] ?? null : null), url: (h) => `https://snapchat.com/add/${h}` },
  telegram: { label: "Telegram", placeholder: "@username or t.me/username", hosts: ["t.me", "telegram.me"], re: /^[A-Za-z][A-Za-z0-9_]{4,31}$/, fromPath: first, url: (h) => `https://t.me/${h}` },
  threads: { label: "Threads", placeholder: "@handle or threads.net/@handle", hosts: ["threads.net", "threads.com"], re: /^(?!.*\.\.)(?!\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/, fromPath: (p) => at(first(p)), url: (h) => `https://www.threads.net/@${h}` },
};

export const SOCIAL_LABELS: Record<SocialKey, string> = {
  ...(Object.fromEntries(Object.entries(SOCIAL_SPECS).map(([k, s]) => [k, s.label])) as Record<Exclude<SocialKey, "website">, string>),
  website: "Website",
};

export type NormResult = { ok: true; value: string | null } | { ok: false; error: string };

function hostOf(u: URL) {
  return u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
}

/** Normalize one field. Empty → { value: null } (clear). */
export function normalizeSocial(key: SocialKey, raw: unknown): NormResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "Invalid value" };
  const input = raw.trim();
  if (!input) return { ok: true, value: null };
  if (input.length > SOCIAL_INPUT_MAX) return { ok: false, error: "Too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f<>"'`\\]/.test(input)) return { ok: false, error: "Contains invalid characters" };

  if (key === "website") {
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
    } catch {
      return { ok: false, error: "Not a valid URL" };
    }
    if (u.protocol === "http:") u.protocol = "https:"; // upgrade plain http links
    if (u.protocol !== "https:") return { ok: false, error: "Website must be an http(s) link" };
    if (u.username || u.password) return { ok: false, error: "Not a valid URL" };
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname)) return { ok: false, error: "Not a valid domain" };
    if (u.port) return { ok: false, error: "Ports aren't allowed" };
    const out = u.toString();
    if (out.length > WEBSITE_MAX) return { ok: false, error: "Too long" };
    return { ok: true, value: out };
  }

  const spec = SOCIAL_SPECS[key];
  let handle: string | null;
  const looksUrl = /^https?:\/\//i.test(input) || /^(www\.|m\.)?[a-z0-9-]+\.[a-z.]+\//i.test(input) || spec.hosts.some((h) => input.toLowerCase().replace(/^(www\.|m\.)/, "") === h);
  if (looksUrl) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      return { ok: false, error: "Not a valid URL" };
    }
    if (!spec.hosts.includes(hostOf(u))) return { ok: false, error: `Use a ${spec.label} link or handle` };
    handle = spec.fromPath(u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponentSafe(p)));
    if (!handle) return { ok: false, error: `Couldn't find a ${spec.label} handle in that link` };
  } else {
    handle = input.replace(/^@/, "");
  }
  if (!spec.re.test(handle)) return { ok: false, error: `Not a valid ${spec.label} handle` };
  return { ok: true, value: spec.url(handle) };
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type SocialFormState = { errors: Partial<Record<SocialKey, string>>; dirty: boolean; canSave: boolean };

/** Form state for the editor: per-field errors (only real messages — never undefined-valued keys),
 *  dirty = any field's normalized value differs from what's saved, canSave = dirty && no errors. */
export function socialFormState(
  draft: Partial<Record<SocialKey, string>>,
  saved: SocialLinks,
  serverErrors: Partial<Record<SocialKey, string | undefined>> = {},
): SocialFormState {
  const errors: Partial<Record<SocialKey, string>> = {};
  let dirty = false;
  for (const k of SOCIAL_KEYS) {
    const raw = draft[k] ?? "";
    const r = normalizeSocial(k, raw);
    const err = r.ok ? serverErrors[k] : r.error;
    if (err) errors[k] = err;
    const value = r.ok ? r.value : raw.trim();
    if ((value ?? "") !== (saved[k] ?? "")) dirty = true;
  }
  return { errors, dirty, canSave: dirty && Object.keys(errors).length === 0 };
}

/** Validate a whole patch. Returns cleaned links (merged onto `current`) or per-field errors. */
export function normalizeSocialLinks(
  input: unknown,
  current: SocialLinks = {},
): { ok: true; links: SocialLinks } | { ok: false; errors: Partial<Record<SocialKey, string>>; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: {}, error: "Invalid social links" };
  const out: SocialLinks = { ...sanitizeStoredLinks(current) };
  const errors: Partial<Record<SocialKey, string>> = {};
  for (const k of SOCIAL_KEYS) {
    if (!(k in input)) continue;
    const r = normalizeSocial(k, (input as Record<string, unknown>)[k]);
    if (!r.ok) errors[k] = r.error;
    else if (r.value) out[k] = r.value;
    else delete out[k];
  }
  if (Object.keys(errors).length) return { ok: false, errors, error: Object.entries(errors).map(([k, e]) => `${SOCIAL_LABELS[k as SocialKey]}: ${e}`)[0] };
  return { ok: true, links: out };
}

/** Defensive read of stored data (DB/JSON): keep only known keys whose value re-normalizes to itself. */
export function sanitizeStoredLinks(raw: unknown): SocialLinks {
  const out: SocialLinks = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of SOCIAL_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== "string") continue;
    const r = normalizeSocial(k, v);
    if (r.ok && r.value) out[k] = r.value;
  }
  return out;
}

/** Short display text for a stored URL (handle, or host for websites). */
export function socialDisplay(key: SocialKey, url: string): string {
  try {
    const u = new URL(url);
    if (key === "website") return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).slice(0, 40);
    const parts = u.pathname.split("/").filter(Boolean);
    const h = (parts.at(-1) ?? "").replace(/^@/, "");
    return key === "linkedin" || key === "snapchat" ? h : `@${h}`;
  } catch {
    return url;
  }
}
