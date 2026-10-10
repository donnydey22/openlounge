export type InlineFormat = "bold" | "italic" | "strike" | "code";

export interface MessageToken {
  kind: "text" | InlineFormat;
  value: string;
}

export interface MessageLine {
  bullet: boolean;
  tokens: MessageToken[];
}

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const DELIMITERS: Record<InlineFormat, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

/**
 * Parse only a deliberately small, safe inline syntax. Message bodies remain plain text in storage and are
 * rendered as React text nodes; raw HTML and links are never interpreted.
 */
export function parseMessageText(text: string): MessageLine[] {
  return text.split(/\r?\n/).map((source) => {
    const bullet = /^\s*•\s+/.test(source) || /^\s*-\s+/.test(source);
    const line = bullet ? source.replace(/^\s*(?:•|- )\s*/, "") : source;
    const tokens: MessageToken[] = [];
    const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
    let cursor = 0;
    for (const match of line.matchAll(pattern)) {
      const value = match[0];
      const index = match.index ?? 0;
      if (index > cursor) tokens.push({ kind: "text", value: line.slice(cursor, index) });
      let kind: InlineFormat;
      let body: string;
      if (value.startsWith("**") || value.startsWith("__")) {
        kind = "bold";
        body = value.slice(2, -2);
      } else if (value.startsWith("~~")) {
        kind = "strike";
        body = value.slice(2, -2);
      } else if (value.startsWith("`")) {
        kind = "code";
        body = value.slice(1, -1);
      } else {
        kind = "italic";
        body = value.slice(1, -1);
      }
      tokens.push({ kind, value: body });
      cursor = index + value.length;
    }
    if (cursor < line.length || tokens.length === 0) tokens.push({ kind: "text", value: line.slice(cursor) });
    return { bullet, tokens };
  });
}

/** Wrap/toggle the current selection using a plain-text delimiter. A collapsed selection inserts a pair. */
export function toggleInlineFormat(value: string, start: number, end: number, format: InlineFormat): TextEdit {
  const delimiter = DELIMITERS[format];
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  if (start === end) {
    const insertion = delimiter + delimiter;
    return {
      value: before + insertion + after,
      selectionStart: start + delimiter.length,
      selectionEnd: start + delimiter.length,
    };
  }

  if (before.endsWith(delimiter) && after.startsWith(delimiter)) {
    const nextStart = start - delimiter.length;
    const nextEnd = end - delimiter.length;
    return {
      value: value.slice(0, nextStart) + selected + value.slice(end + delimiter.length),
      selectionStart: nextStart,
      selectionEnd: nextEnd,
    };
  }

  if (selected.startsWith(delimiter) && selected.endsWith(delimiter) && selected.length >= delimiter.length * 2) {
    const inner = selected.slice(delimiter.length, -delimiter.length);
    return {
      value: before + inner + after,
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }

  return {
    value: before + delimiter + selected + delimiter + after,
    selectionStart: start + delimiter.length,
    selectionEnd: end + delimiter.length,
  };
}

/** Add or remove a visible bullet marker on the line where the caret is. */
export function toggleBullet(value: string, start: number, end: number): TextEdit {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEndAt = value.indexOf("\n", start);
  const lineEnd = lineEndAt < 0 ? value.length : lineEndAt;
  const line = value.slice(lineStart, lineEnd);
  const remove = /^\s*•\s/.test(line);
  const change = remove ? line.replace(/^\s*•\s/, "") : `• ${line}`;
  const delta = change.length - line.length;
  const nextValue = value.slice(0, lineStart) + change + value.slice(lineEnd);
  const adjust = (position: number) => (position >= lineStart ? position + delta : position);
  return {
    value: nextValue,
    selectionStart: Math.max(lineStart, adjust(start)),
    selectionEnd: Math.max(lineStart, adjust(end)),
  };
}
