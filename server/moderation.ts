// UGC safety (App Store guideline 1.2): a small built-in content filter, report reasons and admin config.
//
// Filter policy: profanity is masked (f***), slurs/hate terms are rejected outright. Matching is on word
// boundaries after normalising case, common leetspeak (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s) and repeated
// letters, so "Sh1ttt" is caught but "Scunthorpe" / "classic" / "assess" are not.

/** Masked (first letter kept, rest replaced by *). Words are matched as whole words, optionally with a plural/-ing/-ed suffix. */
const PROFANITY = [
  "fuck", "fucker", "fucking", "motherfucker", "shit", "bullshit", "bitch", "asshole", "bastard", "dick", "dickhead",
  "cunt", "pussy", "cock", "twat", "wanker", "prick", "slut", "whore", "douchebag", "jackass", "piss",
];

/** Rejected: slurs and hate terms. Kept deliberately small; extend via the CONTENT_FILTER_EXTRA_BLOCKED env (comma-separated). */
const BLOCKED = [
  "nigger", "nigga", "faggot", "fag", "retard", "retarded", "kike", "spic", "chink", "wetback", "tranny", "gook",
  "raghead", "towelhead", "coon", "dyke", "beaner", "paki",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "7": "t", "+": "t" };

function extra(): string[] {
  return (process.env.CONTENT_FILTER_EXTRA_BLOCKED ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** normalise one token: lower-case, de-leet, collapse runs of the same letter */
export function normalizeToken(tok: string) {
  let s = tok.toLowerCase().replace(/[0-9!@$+]/g, (c) => LEET[c] ?? c).replace(/[^a-z]/g, "");
  s = s.replace(/(.)\1+/g, "$1");
  return s;
}

const collapse = (w: string) => w.replace(/(.)\1+/g, "$1");
const SUFFIX = ["", "s", "es", "ed", "er", "ers", "ing", "in", "y"];

function matches(norm: string, list: string[]) {
  if (!norm) return false;
  for (const w of list) {
    const c = collapse(w);
    for (const suf of SUFFIX) if (norm === c + suf) return true;
  }
  return false;
}

export type FilterResult = { ok: true; text: string; masked: boolean } | { ok: false; error: string };

/** Mask profanity / reject slurs. Tokens are runs of letters, digits and leet symbols. */
export function filterText(input: string): FilterResult {
  const blocked = [...BLOCKED, ...extra()];
  let masked = false;
  const re = /[A-Za-z0-9!@$+]+/g;
  // first pass: reject
  for (const m of input.matchAll(re)) if (matches(normalizeToken(m[0]), blocked)) return { ok: false, error: "That message contains language that isn't allowed on Open Lounge." };
  // also catch spaced-out / dotted slurs ("n i g g e r", "f.a.g.g.o.t") by checking the letters-only string of short-token runs
  const spaced = input.match(/(?:\b[A-Za-z0-9@$]\b[\s.\-_*]*){3,}/g) ?? [];
  for (const s of spaced) if (matches(normalizeToken(s), blocked)) return { ok: false, error: "That message contains language that isn't allowed on Open Lounge." };
  const text = input.replace(re, (tok) => {
    if (!matches(normalizeToken(tok), PROFANITY)) return tok;
    masked = true;
    return tok[0] + "*".repeat(Math.max(1, tok.length - 1));
  });
  return { ok: true, text, masked };
}

// ---------- reports ----------

export const REPORT_REASONS = ["spam", "harassment", "hate", "sexual", "violence", "self_harm", "impersonation", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_TARGETS = ["user", "room", "message", "dm"] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export interface ReportRecord {
  id: string;
  reporterId: string;
  targetType: ReportTarget;
  /** user id, room id, or message id */
  targetId: string;
  /** the user responsible for the content (message author, room host, or the reported user) */
  targetUserId: string | null;
  roomId: string | null;
  reason: ReportReason;
  note: string;
  /** copy of the reported text at report time (message body / room title / bio) */
  snapshot: string;
  status: "open" | "reviewed" | "actioned" | "dismissed";
  createdAt: number;
}

/** Admins: env ADMIN_USER_IDS (comma-separated). Donny's account is always included. */
export const DEFAULT_ADMIN_IDS = ["u_05c86a26-3707-4c45-9147-bdbdd0189b58"];
export function adminIds(): Set<string> {
  const env = (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_ADMIN_IDS, ...env]);
}
export const isAdmin = (userId: string) => adminIds().has(userId);

export const SUPPORT_EMAIL = "outthereendlessly@gmail.com";
