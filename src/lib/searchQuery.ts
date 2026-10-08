// Search query grammar shared by the client and /hx/search: "#tag", "@handle" and plain words, intersected (AND).
//   "@maya #music"  → messages that mention maya AND are tagged #music; rooms by maya tagged #music; maya's card
//   "dinner #plans" → messages tagged #plans that contain "dinner" (prefix + partial-word match)
import { isValidTag, normalizeTag } from "./linkify";

export type ParsedQuery = { tags: string[]; mentions: string[]; words: string[] };

const HANDLE = /^[a-z0-9_]{3,20}$/;
const WORD_CHARS = /[^\p{L}\p{N}\p{M}_]+/gu;

export function parseSearchQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { tags: [], mentions: [], words: [] };
  for (const raw of q.slice(0, 300).split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith("#")) {
      const t = normalizeTag(raw.replace(/[^\p{L}\p{N}\p{M}_#]+$/u, ""));
      if (isValidTag(t) && !out.tags.includes(t)) out.tags.push(t);
      continue;
    }
    if (raw.startsWith("@")) {
      const h = raw.slice(1).replace(/[^A-Za-z0-9_]+$/, "").toLowerCase();
      if (HANDLE.test(h) && !out.mentions.includes(h)) out.mentions.push(h);
      continue;
    }
    for (const w of raw.normalize("NFKC").toLowerCase().split(WORD_CHARS)) if (w && w.length <= 64 && !out.words.includes(w)) out.words.push(w);
  }
  out.tags = out.tags.slice(0, 5);
  out.mentions = out.mentions.slice(0, 3);
  out.words = out.words.slice(0, 8);
  return out;
}

export const isEmptyQuery = (p: ParsedQuery) => !p.tags.length && !p.mentions.length && !p.words.length;

/** The token being typed at the end of the input: "#mu" → { kind: "tag", prefix: "mu" } (for suggestions). */
export function typingToken(q: string): { kind: "tag" | "mention"; prefix: string } | null {
  const m = q.match(/(?:^|\s)([#@])([^\s#@]*)$/u);
  if (!m) return null;
  return m[1] === "#" ? { kind: "tag", prefix: normalizeTag(m[2]) } : { kind: "mention", prefix: m[2].toLowerCase() };
}

/** Does `text` match every plain word (case-insensitive substring, like the server's partial-word match)? */
export function matchesWords(text: string, words: string[]) {
  const t = text.normalize("NFKC").toLowerCase();
  return words.every((w) => t.includes(w));
}
