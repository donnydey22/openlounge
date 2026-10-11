import { test } from "node:test";
import assert from "node:assert/strict";
import { enterSends, newline, tabIndents, indentLines } from "../src/lib/composer/keys";
test("Enter: desktop sends, phones newline, Shift newline, Ctrl/Cmd sends", () => {
  assert.equal(enterSends({ coarse: false, shift: false, mod: false }), true);
  assert.equal(enterSends({ coarse: true, shift: false, mod: false }), false);
  assert.equal(enterSends({ coarse: false, shift: true, mod: false }), false);
  assert.equal(enterSends({ coarse: true, shift: false, mod: true }), true);
});
test("newline keeps indentation and continues lists; empty item ends the list", () => {
  assert.deepEqual(newline("hello", 5, 5), { text: "hello\n", start: 6, end: 6 });
  assert.deepEqual(newline("  code", 6, 6), { text: "  code\n  ", start: 9, end: 9 });
  assert.deepEqual(newline("- a", 3, 3), { text: "- a\n- ", start: 6, end: 6 });
  assert.deepEqual(newline("  * a", 5, 5).text, "  * a\n  * ");
  assert.deepEqual(newline("1. a", 4, 4).text, "1. a\n2. ");
  assert.deepEqual(newline("> q", 3, 3).text, "> q\n> ");
  assert.deepEqual(newline("- a\n- ", 6, 6), { text: "- a\n", start: 4, end: 4 });
  assert.deepEqual(newline("ab", 1, 1).text, "a\nb");
  assert.deepEqual(newline("abc", 1, 2).text, "a\nc");
  // a hyphenated word is not a list
  assert.deepEqual(newline("-a", 2, 2).text, "-a\n");
});
test("Tab indents only multi-line text / selections", () => {
  assert.equal(tabIndents("one line", 0, 0), false);
  assert.equal(tabIndents("a\nb", 0, 0), true);
});
test("indent / outdent selected lines", () => {
  assert.deepEqual(indentLines("a\nb\nc", 0, 3, false), { text: "  a\n  b\nc", start: 2, end: 7 });
  assert.deepEqual(indentLines("  a\n  b", 0, 7, true), { text: "a\nb", start: 0, end: 3 });
  assert.deepEqual(indentLines("a\nb", 3, 3, false), { text: "a\n  b", start: 5, end: 5 });
  assert.deepEqual(indentLines("x", 0, 0, true), { text: "x", start: 0, end: 0 });
});
