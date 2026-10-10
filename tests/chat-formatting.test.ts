import assert from "node:assert/strict";
import test from "node:test";
import { parseMessageText, toggleBullet, toggleInlineFormat } from "../src/lib/chatFormatting";

test("parses bold, italic, strike, and code as inert text segments", () => {
  assert.deepEqual(parseMessageText("**strong** *em* ~~gone~~ `code`"), [
    {
      bullet: false,
      tokens: [
        { kind: "bold", value: "strong" },
        { kind: "text", value: " " },
        { kind: "italic", value: "em" },
        { kind: "text", value: " " },
        { kind: "strike", value: "gone" },
        { kind: "text", value: " " },
        { kind: "code", value: "code" },
      ],
    },
  ]);
});

test("preserves paragraph breaks and turns explicit list prefixes into bullets", () => {
  const parsed = parseMessageText("first paragraph\n\n- one\n• two");
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].tokens[0].value, "first paragraph");
  assert.equal(parsed[1].tokens[0].value, "");
  assert.equal(parsed[2].bullet, true);
  assert.equal(parsed[2].tokens[0].value, "one");
  assert.equal(parsed[3].bullet, true);
  assert.equal(parsed[3].tokens[0].value, "two");
});

test("raw HTML remains ordinary text and is never treated as markup", () => {
  assert.deepEqual(parseMessageText("<img src=x onerror=alert(1)>"), [
    { bullet: false, tokens: [{ kind: "text", value: "<img src=x onerror=alert(1)>" }] },
  ]);
});

test("format toolbar wraps, unwraps, and inserts paired markers at a caret", () => {
  assert.deepEqual(toggleInlineFormat("hello", 0, 5, "bold"), {
    value: "**hello**",
    selectionStart: 2,
    selectionEnd: 7,
  });
  assert.deepEqual(toggleInlineFormat("**hello**", 2, 7, "bold"), {
    value: "hello",
    selectionStart: 0,
    selectionEnd: 5,
  });
  assert.deepEqual(toggleInlineFormat("ab", 1, 1, "italic"), {
    value: "a**b",
    selectionStart: 2,
    selectionEnd: 2,
  });
});

test("bulleted-list toolbar toggles only the current line and keeps selection usable", () => {
  assert.deepEqual(toggleBullet("first\nsecond\nthird", 8, 12), {
    value: "first\n• second\nthird",
    selectionStart: 10,
    selectionEnd: 14,
  });
  assert.deepEqual(toggleBullet("first\n• second\nthird", 10, 14), {
    value: "first\nsecond\nthird",
    selectionStart: 8,
    selectionEnd: 12,
  });
});
