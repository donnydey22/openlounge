// Chat link detection + safety classification (Telegram/WhatsApp style). Pure, no DOM: unit-tested in tests/links.
//
// - Finds http(s) URLs, www.* and bare domains with a known TLD, e-mail addresses (→ mailto:) and international
//   phone numbers (+… → tel:). Nothing else ever becomes a link (javascript:, data:, file:, intent:, … stay text).
// - Every link is re-built from a parsed URL (WHATWG), so what we render is exactly what opens.
// - Classifies: internal (openlounge.app, safe in-app path → client-side navigation), external (confirm sheet),
//   mailto / tel (opened directly by the OS). Flags punycode / non-ASCII / mixed-script hosts, look-alikes of
//   openlounge.app, raw IP hosts, user:pass@ tricks and non-standard ports.

export type LinkKind = "internal" | "external" | "mailto" | "tel";
export type LinkToken = {
  type: "link";
  /** the exact text the sender typed (what we show) */
  text: string;
  /** normalised, safe href */
  href: string;
  kind: LinkKind;
  /** ASCII (punycode-decoded where relevant) host for display in the confirm sheet */
  host: string;
  /** in-app path for internal links */
  path?: string;
  /** human-readable warnings; non-empty → suspicious */
  warnings: string[];
};
export type TextToken = { type: "text"; text: string };
/** #tag: `tag` is the lowercase-normalised key used for search */
export type HashtagToken = { type: "hashtag"; text: string; tag: string };
/** @screen_name (same rule as group @mention notifications: 3–20 letters/digits/_); `handle` is lowercase */
export type MentionToken = { type: "mention"; text: string; handle: string };
export type Token = TextToken | LinkToken | HashtagToken | MentionToken;

// No lookbehind anywhere in this file: Safari < 16.4 (iOS 15 / 16.0–16.3) can't even parse a lookbehind regex literal,
// which kills the whole chunk (this module is in the root layout bundle). The "not glued to …" rules are checked on the
// previous character in code instead (matchAllNoLB), with the same results.
const MENTION_RE = /@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_@])/gu;
const MENTION_BEFORE = /[\p{L}\p{N}\p{M}_@&/#.]/u;

// #tag: Unicode letters/digits/underscore (+ combining marks), >=1 letter, <=64 chars; not glued to a word, "&#" or "/#"
const HASHTAG_RE = /#([\p{L}\p{N}\p{M}_]{1,64})(?![\p{L}\p{N}\p{M}_])/gu;
const HASHTAG_BEFORE = /[\p{L}\p{N}\p{M}_&/#]/u;

/**
 * Like text.matchAll(re), minus matches whose previous character fits `before(m)` (a negative lookbehind). A rejected
 * match restarts the search one position later, exactly like the regex engine would.
 */
function* matchAllNoLB(text: string, re: RegExp, before: (m: RegExpExecArray) => RegExp): Generator<RegExpExecArray> {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    const start = m.index;
    if (start > 0 && before(m).test(text[start - 1])) {
      r.lastIndex = start + 1;
      continue;
    }
    if (m[0] === "") r.lastIndex++;
    yield m;
  }
}
const HAS_LETTER = /\p{L}/u;
export const normalizeTag = (t: string) => t.replace(/^#/, "").normalize("NFKC").toLowerCase();
export const isValidTag = (t: string) => /^[\p{L}\p{N}\p{M}_]{1,64}$/u.test(t) && HAS_LETTER.test(t);

type InlineToken = TextToken | HashtagToken | MentionToken;
const INLINE_RE = new RegExp(`${HASHTAG_RE.source}|${MENTION_RE.source}`, "gu");

/** #hashtags and @mentions in plain text (no links): skips `code spans`. */
export function splitHashtags(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const parts = text.split(/(`[^`\n]*`)/); // odd parts = code spans, never tags
  let buf = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 1) {
      buf += part;
      continue;
    }
    let pos = 0;
    for (const m of matchAllNoLB(part, INLINE_RE, (x) => (x[1] !== undefined ? HASHTAG_BEFORE : MENTION_BEFORE))) {
      if (m[1] !== undefined && !HAS_LETTER.test(m[1])) continue;
      const start = m.index ?? 0;
      buf += part.slice(pos, start);
      if (buf) out.push({ type: "text", text: buf });
      buf = "";
      out.push(m[1] !== undefined ? { type: "hashtag", text: m[0], tag: normalizeTag(m[1]) } : { type: "mention", text: m[0], handle: m[2].toLowerCase() });
      pos = start + m[0].length;
    }
    buf += part.slice(pos);
  }
  if (buf) out.push({ type: "text", text: buf });
  return out;
}

/** Unique, lowercase @handles in a text (links, e-mails and code excluded). */
export function extractMentions(text: string): string[] {
  const set = new Set<string>();
  for (const t of linkify(text)) if (t.type === "mention") set.add(t.handle);
  return [...set];
}

/** Unique, normalised hashtags in a text (links, e-mails and code excluded). */
export function extractHashtags(text: string): string[] {
  const set = new Set<string>();
  for (const t of linkify(text)) if (t.type === "hashtag") set.add(t.tag);
  return [...set];
}

export const APP_HOSTS = new Set(["openlounge.app", "www.openlounge.app"]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

// in-app pages a chat link may open without leaving the app (everything else on our host still gets the sheet)
const INTERNAL_PATH = /^\/(?:$|room\/[\w-]{1,64}\/?$|messages(?:\/[\w-]{1,80})?\/?$|profile\/[\w-]{1,80}\/?$|u\/[\w.-]{1,40}\/?$|@[\w.]{1,40}\/?$|explore\/?$|invite\/?$|download\/?$|settings\/?$|terms\/?$|privacy\/?$)/;

// common TLDs for scheme-less links ("example.com", "openlounge.app"); www.* always counts
const TLDS =
  "com|net|org|app|io|co|dev|ai|me|tv|gg|fm|ly|us|uk|ca|de|fr|es|it|nl|se|no|fi|dk|pl|ru|ua|in|jp|cn|kr|au|nz|br|mx|ar|za|ng|edu|gov|info|biz|xyz|site|online|store|shop|blog|news|live|link|page|club|world|chat|social|media|music|video|art|design|tech|cloud|so|to|sh|is|ch|at|be|ie|pt|gr|tr|il|ae|sa|sg|hk|tw|id|ph|vn|th|my";

// URL-ish run: scheme://…, www.…, or domain.tld/… ; stops at whitespace and <>"`
const URL_RE = new RegExp(
  String.raw`(?:\b(?:https?:\/\/)[^\s<>"\x60]+)|(?:\bwww\.[^\s<>"\x60]+)|(?:\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS})\b(?:[/?#][^\s<>"\x60]*)?)`,
  "giu",
);
const EMAIL_RE = /\b(?:mailto:)?[a-z0-9._%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}\b/giu;
const PHONE_RE = /(?:tel:)?\+\d[\d ()-]{6,18}\d(?!\w)/gu;
const PHONE_BEFORE = /[\w+]/u;

const TRAILING = /[.,!?;:'"’”)\]}>*_~]/u;

/** Trim trailing punctuation that is almost never part of the URL; keep a balanced ")" (Wikipedia links). */
function trimTrailing(s: string): string {
  let out = s;
  while (out && TRAILING.test(out[out.length - 1])) {
    const c = out[out.length - 1];
    if (c === ")") {
      const opens = (out.match(/\(/g) || []).length;
      const closes = (out.match(/\)/g) || []).length;
      if (opens >= closes) break; // this ")" closes a "(" inside the URL
    }
    out = out.slice(0, -1);
  }
  return out;
}

// ----- host checks -----
const SCRIPT_RES: [string, RegExp][] = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Han", /\p{Script=Han}/u],
  ["Cherokee", /\p{Script=Cherokee}/u],
];

/** Minimal RFC 3492 punycode decoder (for display/warnings only). */
export function punyDecode(label: string): string {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  let n = 128, i = 0, bias = 72;
  const out: number[] = [];
  const b = label.lastIndexOf("-");
  for (let j = 0; j < Math.max(0, b); j++) out.push(label.charCodeAt(j));
  let pos = b > 0 ? b + 1 : 0;
  const adapt = (delta: number, num: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / num);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  while (pos < label.length) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (pos >= label.length) throw new Error("bad punycode");
      const c = label.charCodeAt(pos++);
      const d = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (d >= base) throw new Error("bad punycode");
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

export function unicodeHost(asciiHost: string): string {
  return asciiHost
    .split(".")
    .map((l) => {
      if (!l.startsWith("xn--")) return l;
      try {
        return punyDecode(l.slice(4));
      } catch {
        return l;
      }
    })
    .join(".");
}

// visually confusable → ASCII skeleton (enough for brand look-alikes)
const CONFUSABLE: Record<string, string> = { "0": "o", "1": "l", "3": "e", "5": "s", "|": "l", "і": "i", "о": "o", "е": "e", "а": "a", "р": "p", "с": "c", "ո": "n", "ս": "u", "ɡ": "g", "ⅼ": "l", "ı": "i", "ӏ": "l" };
const skeleton = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split("")
    .map((c) => CONFUSABLE[c] ?? c)
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w");

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function hostWarnings(asciiHost: string, url: URL): string[] {
  const w: string[] = [];
  const uni = unicodeHost(asciiHost);
  if (uni !== asciiHost || /[^\x00-\x7f]/.test(uni)) {
    w.push(`The address uses special characters (${asciiHost}) that can imitate other sites.`);
    const scripts = SCRIPT_RES.filter(([, re]) => re.test(uni.replace(/[.\-0-9]/g, ""))).map(([n]) => n);
    if (scripts.length > 1) w.push(`It mixes ${scripts.join(" and ")} letters.`);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(asciiHost) || asciiHost.startsWith("[")) w.push("It points to a raw IP address instead of a site name.");
  if (url.username || url.password) w.push("It hides its real destination behind a user name (the part before @).");
  if (url.port && url.port !== "80" && url.port !== "443") w.push(`It uses an unusual port (${url.port}).`);
  if (!APP_HOSTS.has(asciiHost)) {
    const labels = uni.split(".");
    const main = labels.length >= 2 ? labels.slice(-2).join(".") : uni;
    const sk = skeleton(main);
    const brand = "openlounge.app";
    const mentionsBrand = skeleton(uni).replace(/[^a-z]/g, "").includes("openlounge");
    if (sk === brand || (levenshtein(sk, brand) <= 2 && main !== brand)) w.push("It looks like openlounge.app but isn't.");
    else if (mentionsBrand) w.push("It mentions Open Lounge but isn't openlounge.app.");
  }
  return Array.from(new Set(w));
}

function classifyUrl(text: string, raw: string): LinkToken | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol === "mailto:" || url.protocol === "tel:") return null; // handled by their own matchers
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return null;
  const warnings = hostWarnings(host, url);
  const pathQ = url.pathname + url.search + url.hash;
  if (APP_HOSTS.has(host) && !url.username && !url.password && !url.port && INTERNAL_PATH.test(url.pathname)) {
    return { type: "link", text, href: `https://${host}${pathQ}`, kind: "internal", host, path: pathQ, warnings: [] };
  }
  return { type: "link", text, href: url.href, kind: "external", host, warnings };
}

type Match = { start: number; end: number; token: LinkToken };

/** Split chat text into plain text and link tokens. Never throws; caps work for very long messages. */
export function linkify(input: string): Token[] {
  const text = typeof input === "string" ? input.slice(0, 20000) : "";
  if (!text) return [];
  const matches: Match[] = [];
  const overlaps = (s: number, e: number) => matches.some((m) => s < m.end && e > m.start);

  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    // skip the domain part of an e-mail address (handled below)
    if (start > 0 && text[start - 1] === "@") continue;
    const t = trimTrailing(m[0]);
    if (!t) continue;
    const raw = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    const tok = classifyUrl(t, raw);
    if (tok) matches.push({ start, end: start + t.length, token: tok });
    if (matches.length > 200) break;
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const start = m.index ?? 0;
    const t = m[0];
    if (overlaps(start, start + t.length)) {
      // "user@example.com" also matched "example.com" as a URL → the e-mail wins
      for (let i = matches.length - 1; i >= 0; i--) if (matches[i].start >= start && matches[i].end <= start + t.length) matches.splice(i, 1);
      if (overlaps(start, start + t.length)) continue;
    }
    const addr = t.replace(/^mailto:/i, "");
    const domain = addr.split("@")[1].toLowerCase();
    let warnings: string[] = [];
    try {
      warnings = hostWarnings(domain, new URL(`https://${domain}`)).filter((w) => !/user name/.test(w));
    } catch {
      continue;
    }
    matches.push({ start, end: start + t.length, token: { type: "link", text: t, href: `mailto:${addr}`, kind: "mailto", host: domain, warnings } });
  }
  for (const m of matchAllNoLB(text, PHONE_RE, () => PHONE_BEFORE)) {
    const start = m.index ?? 0;
    const t = m[0];
    if (overlaps(start, start + t.length)) continue;
    const digits = t.replace(/^tel:/i, "").replace(/[^\d+]/g, "");
    if (digits.length < 8 || digits.length > 16) continue;
    matches.push({ start, end: start + t.length, token: { type: "link", text: t, href: `tel:${digits}`, kind: "tel", host: digits, warnings: [] } });
  }
  matches.sort((a, b) => a.start - b.start);
  const out: Token[] = [];
  let pos = 0;
  const pushText = (t: string) => {
    if (t.includes("#") || t.includes("@")) out.push(...splitHashtags(t));
    else out.push({ type: "text", text: t });
  };
  for (const m of matches) {
    if (m.start < pos) continue;
    if (m.start > pos) pushText(text.slice(pos, m.start));
    out.push(m.token);
    pos = m.end;
  }
  if (pos < text.length) pushText(text.slice(pos));
  return out;
}

/** First external http(s) link in a message (for the link preview card). */
export function firstPreviewableLink(text: string): LinkToken | null {
  for (const t of linkify(text)) if (t.type === "link" && t.kind === "external" && t.warnings.length === 0 && /^https:/.test(t.href)) return t;
  return null;
}
