// Composer keyboard behaviour (pure, unit-tested): Grok-style multi-line editing.
//  - Phones / tablets (coarse pointer, no hardware keyboard signal): Return inserts a newline; the send button sends.
//  - Desktop: Enter sends, Shift+Enter newline (Ctrl/Cmd+Enter also sends).
//  - A newline keeps the current line's indentation and continues "- " / "* " / "• " / "1. " / "> " lists;
//    Return on an empty list item ends the list.
//  - Tab / Shift+Tab indent / outdent the selected lines when the text is multi-line or the selection spans lines;
//    otherwise Tab keeps moving focus (accessibility).
export const INDENT = "  ";

export interface Edit {
  text: string;
  start: number;
  end: number;
}

export function enterSends(opts: { coarse: boolean; shift: boolean; mod: boolean }): boolean {
  if (opts.mod) return true;
  if (opts.shift) return false;
  return !opts.coarse;
}

const LIST_RE = /^(\s*)((?:[-*•]|\d{1,3}[.)]|>)\s+)?/;

/** Insert a newline at the selection, carrying indentation / list markers. */
export function newline(text: string, start: number, end: number): Edit {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const line = text.slice(lineStart, start);
  const m = LIST_RE.exec(line)!;
  const indent = m[1] ?? "";
  let marker = m[2] ?? "";
  // empty list item → end the list (remove the marker, plain newline)
  if (marker && line.trim() === marker.trim()) {
    const next = text.slice(0, lineStart) + indent + text.slice(end);
    const pos = lineStart + indent.length;
    return { text: next, start: pos, end: pos };
  }
  const num = /^(\d{1,3})([.)])(\s+)$/.exec(marker);
  if (num) marker = `${Number(num[1]) + 1}${num[2]}${num[3]}`;
  const ins = "\n" + indent + marker;
  const next = text.slice(0, start) + ins + text.slice(end);
  const pos = start + ins.length;
  return { text: next, start: pos, end: pos };
}

/** Should Tab indent here (vs. move focus)? */
export function tabIndents(text: string, start: number, end: number): boolean {
  return text.includes("\n") || text.slice(start, end).includes("\n");
}

/** Indent (or outdent) every line touched by the selection. */
export function indentLines(text: string, start: number, end: number, outdent: boolean): Edit {
  const a = text.lastIndexOf("\n", start - 1) + 1;
  const bIdx = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  const b = bIdx === -1 ? text.length : bIdx;
  const lines = text.slice(a, b).split("\n");
  let dStart = 0;
  let dTotal = 0;
  const out = lines.map((l, i) => {
    let d: number;
    let nl: string;
    if (outdent) {
      const rm = l.startsWith(INDENT) ? INDENT.length : l.startsWith(" ") || l.startsWith("\t") ? 1 : 0;
      nl = l.slice(rm);
      d = -rm;
    } else {
      nl = INDENT + l;
      d = INDENT.length;
    }
    if (i === 0) dStart = d;
    dTotal += d;
    return nl;
  });
  const next = text.slice(0, a) + out.join("\n") + text.slice(b);
  const s = Math.max(a, start + dStart);
  const e = start === end ? s : Math.max(s, end + dTotal);
  return { text: next, start: s, end: e };
}
