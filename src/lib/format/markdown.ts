// Telegram-style message formatting (MarkdownV2 syntax), parsed leniently for people typing by hand:
//   *bold*  **bold**  _italic_  __underline__  ~strikethrough~  ||spoiler||  `code`  ```pre```  [text](url)  "> quote"
// - Messages keep the raw text (no data model / WS change; old clients just show the markers).
// - A marker only formats when it is closed on the same message and hugs its text (`*a*` yes, `a * b * c` no), and
//   single-character markers need a word boundary outside (snake_case_names and 2*3*4 stay as typed).
// - Backslash escapes any marker character (`\*` → *). Code / pre content is literal.
// - Never produces HTML: the result is a small node tree rendered as React elements (FormattedText.tsx).
// - Links: only http / https / mailto / tel; anything else ([x](javascript:…), data:, file:, …) stays plain text.

export type MdNode =
  | { t: "text"; v: string }
  | { t: "b" | "i" | "u" | "s" | "sp"; c: MdNode[] }
  | { t: "code"; v: string }
  | { t: "pre"; v: string; lang?: string }
  | { t: "link"; href: string; c: MdNode[] }
  | { t: "quote"; c: MdNode[] };

export type MdStyle = "b" | "i" | "u" | "s" | "sp" | "code";

/** marker characters a backslash can escape */
const ESCAPABLE = new Set("_*[]()~`>#+-=|{}.!\\".split(""));
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
const MAX_DEPTH = 6;
const MAX_LEN = 8000;

/** inline delimiters, longest first (so `__` wins over `_`, `||` and `**` over single characters) */
const DELIMS: { m: string; t: "b" | "i" | "u" | "s" | "sp"; word: boolean }[] = [
  { m: "||", t: "sp", word: false },
  { m: "**", t: "b", word: true },
  { m: "__", t: "u", word: true },
  { m: "*", t: "b", word: true },
  { m: "_", t: "i", word: true },
  { m: "~", t: "s", word: true },
];

export const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** A link target we are willing to render as a link, normalized; null = keep as text. */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 2048 || /[\s<>"]/.test(s)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /^www\./i.test(s) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s) ? `https://${s}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    if (!SAFE_LINK_PROTOCOLS.has(u.protocol)) return null;
    if ((u.protocol === "http:" || u.protocol === "https:") && !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

const isWord = (ch: string | undefined) => !!ch && WORD.test(ch);
const isSpace = (ch: string | undefined) => !ch || SPACE.test(ch);

/** index of the closing delimiter for an opener at `from` (content start), or -1 */
function findClose(s: string, from: number, end: number, m: string, word: boolean): number {
  for (let j = from; j <= end - m.length; j++) {
    const ch = s[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "`") {
      // don't close inside a code span
      const k = s.indexOf("`", j + 1);
      if (k > 0 && k < end) {
        j = k;
        continue;
      }
    }
    if (!s.startsWith(m, j)) continue;
    if (j === from) continue; // empty
    if (isSpace(s[j - 1])) continue;
    // `**` must not be mistaken for the end of `*`… (and `__` for `_`)
    if (m.length === 1 && s[j + 1] === m) {
      j++;
      continue;
    }
    if (word && isWord(s[j + m.length]) && j + m.length < end) continue;
    return j;
  }
  return -1;
}

function parseInline(s: string, start: number, end: number, depth: number): MdNode[] {
  const out: MdNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = start;
  while (i < end) {
    const ch = s[i];
    // escapes
    if (ch === "\\" && i + 1 < end && ESCAPABLE.has(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    // ```pre``` (may span lines; an optional language word on the first line)
    if (ch === "`" && s.startsWith("```", i)) {
      const close = s.indexOf("```", i + 3);
      if (close > i + 3 && close + 3 <= end) {
        let body = s.slice(i + 3, close);
        let lang: string | undefined;
        const nl = body.indexOf("\n");
        if (nl > 0 && /^[\w+#.-]{1,20}$/.test(body.slice(0, nl))) {
          lang = body.slice(0, nl);
          body = body.slice(nl + 1);
        } else if (nl === 0) body = body.slice(1);
        if (body.endsWith("\n")) body = body.slice(0, -1);
        flush();
        out.push(lang ? { t: "pre", v: body, lang } : { t: "pre", v: body });
        i = close + 3;
        continue;
      }
    }
    // `code`
    if (ch === "`") {
      let j = i + 1;
      let v = "";
      while (j < end && s[j] !== "`" && s[j] !== "\n") {
        if (s[j] === "\\" && (s[j + 1] === "`" || s[j + 1] === "\\")) {
          v += s[j + 1];
          j += 2;
          continue;
        }
        v += s[j++];
      }
      if (j < end && s[j] === "`" && v) {
        flush();
        out.push({ t: "code", v });
        i = j + 1;
        continue;
      }
    }
    // [text](url)
    if (ch === "[" && depth < MAX_DEPTH) {
      const close = findBracket(s, i + 1, end);
      if (close > i + 1 && s[close + 1] === "(") {
        const paren = s.indexOf(")", close + 2);
        if (paren > close + 2 && paren < end) {
          const href = safeHref(s.slice(close + 2, paren));
          if (href) {
            flush();
            out.push({ t: "link", href, c: parseInline(s, i + 1, close, depth + 1) });
            i = paren + 1;
            continue;
          }
        }
      }
    }
    // emphasis
    if (depth < MAX_DEPTH) {
      let matched = false;
      for (const d of DELIMS) {
        if (!s.startsWith(d.m, i)) continue;
        const after = s[i + d.m.length];
        if (isSpace(after) || after === d.m[0]) continue;
        if (d.word && isWord(s[i - 1]) && i > start) continue;
        const close = findClose(s, i + d.m.length, end, d.m, d.word);
        if (close < 0) continue;
        flush();
        out.push({ t: d.t, c: parseInline(s, i + d.m.length, close, depth + 1) });
        i = close + d.m.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function findBracket(s: string, from: number, end: number) {
  for (let j = from; j < end; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "\n") return -1;
    if (s[j] === "]") return j;
  }
  return -1;
}

/** Parse a whole message: "> " quote lines (consecutive lines form one quote) + inline formatting. */
export function parseMarkdown(text: string): MdNode[] {
  const s = text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text;
  if (!/[*_~|`[>\\]/.test(s)) return [{ t: "text", v: s }];
  // "> " quote lines (outside ``` blocks) become block quotes; consecutive lines are one quote. The line break next to a
  // quote is the block edge itself, so it is not kept as text.
  const lines = s.split("\n");
  const out: MdNode[] = [];
  let plain: string[] = [];
  let inPre = false;
  const flushPlain = () => {
    if (!plain.length) return;
    const body = plain.join("\n");
    out.push(...parseInline(body, 0, body.length, 0));
    plain = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!inPre && /^>\s/.test(line)) {
      flushPlain();
      const q: string[] = [];
      while (i < lines.length && /^>\s/.test(lines[i])) q.push(lines[i++].replace(/^>\s/, ""));
      const body = q.join("\n");
      out.push({ t: "quote", c: parseInline(body, 0, body.length, 1) });
      continue;
    }
    if ((line.match(/```/g) ?? []).length % 2 === 1) inPre = !inPre;
    plain.push(line);
    i++;
  }
  flushPlain();
  return merge(out);
}

function merge(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.t === "text" && !n.v) continue;
    if (n.t === "text" && last?.t === "text") last.v += n.v;
    else out.push(n);
  }
  return out;
}

/** True when the message uses any formatting (cheap pre-check for the renderer). */
export function hasMarkdown(text: string): boolean {
  if (!/[*_~|`[>\\]/.test(text)) return false;
  const n = parseMarkdown(text);
  return !(n.length === 1 && n[0].t === "text" && n[0].v === text);
}

/** Plain text without markers (notifications, chat list previews, copy as plain text). Spoilers are masked. */
export function plainText(text: string, opts: { spoiler?: "mask" | "keep" } = {}): string {
  const walk = (ns: MdNode[]): string =>
    ns
      .map((n) =>
        n.t === "text" || n.t === "code" || n.t === "pre"
          ? n.v
          : n.t === "sp" && opts.spoiler !== "keep"
          ? "▒".repeat(Math.min(12, Math.max(3, walk(n.c).length)))
          : n.t === "quote"
          ? walk(n.c)
          : walk(n.c),
      )
      .join("");
  return walk(parseMarkdown(text));
}

// ---- composer: wrap / unwrap a selection (toolbar + Ctrl/Cmd shortcuts) ----

export const STYLE_MARKERS: Record<MdStyle, string> = { b: "*", i: "_", u: "__", s: "~", sp: "||", code: "`" };

/**
 * Toggle a style on text[start, end): wraps it in the marker (trimming spaces out of the selection so the marker hugs
 * the words), or removes the marker if the selection is already wrapped. Returns the new text and selection.
 */
export function toggleStyle(text: string, start: number, end: number, style: MdStyle): { text: string; start: number; end: number } {
  const m = STYLE_MARKERS[style];
  let a = Math.min(start, end);
  let b = Math.max(start, end);
  while (a < b && SPACE.test(text[a])) a++;
  while (b > a && SPACE.test(text[b - 1])) b--;
  // already wrapped (markers just outside or just inside the selection) → unwrap
  if (text.slice(a - m.length, a) === m && text.slice(b, b + m.length) === m && b > a) {
    const t = text.slice(0, a - m.length) + text.slice(a, b) + text.slice(b + m.length);
    return { text: t, start: a - m.length, end: b - m.length };
  }
  const inner = text.slice(a, b);
  if (inner.length > 2 * m.length && inner.startsWith(m) && inner.endsWith(m)) {
    const t = text.slice(0, a) + inner.slice(m.length, -m.length) + text.slice(b);
    return { text: t, start: a, end: b - 2 * m.length };
  }
  if (a === b) {
    // nothing selected: insert a marker pair and put the caret between them
    const t = text.slice(0, a) + m + m + text.slice(a);
    return { text: t, start: a + m.length, end: a + m.length };
  }
  // single-char markers need a boundary: if glued to a word, Telegram-like behaviour is still to wrap
  const t = text.slice(0, a) + m + inner + m + text.slice(b);
  return { text: t, start: a + m.length, end: b + m.length };
}

/** Wrap a selection as a link: [selection](url). */
export function wrapLink(text: string, start: number, end: number, url: string): { text: string; start: number; end: number } | null {
  const href = safeHref(url);
  if (!href) return null;
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  const label = text.slice(a, b) || url.trim();
  const ins = `[${label.replace(/[[\]]/g, (c) => "\\" + c)}](${url.trim()})`;
  return { text: text.slice(0, a) + ins + text.slice(b), start: a + ins.length, end: a + ins.length };
}
