// Telegram-style formatting parser (src/lib/format/markdown.ts): lenient MarkdownV2, safe links, toolbar toggles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown as p, plainText, safeHref, toggleStyle, wrapLink, hasMarkdown } from "../../src/lib/format/markdown";

const T = (v: string) => ({ t: "text", v });

test("basic styles", () => {
  assert.deepEqual(p("hi *there*"), [T("hi "), { t: "b", c: [T("there")] }]);
  assert.deepEqual(p("**bold** too"), [{ t: "b", c: [T("bold")] }, T(" too")]);
  assert.deepEqual(p("_it_ __un__ ~st~ ||sp||"), [
    { t: "i", c: [T("it")] }, T(" "), { t: "u", c: [T("un")] }, T(" "), { t: "s", c: [T("st")] }, T(" "), { t: "sp", c: [T("sp")] },
  ]);
  assert.deepEqual(p("run `npm i` now"), [T("run "), { t: "code", v: "npm i" }, T(" now")]);
  assert.deepEqual(p("```js\nconst a = *1*;\n```"), [{ t: "pre", v: "const a = *1*;", lang: "js" }]);
  assert.deepEqual(p("*bold _and italic_*"), [{ t: "b", c: [T("bold "), { t: "i", c: [T("and italic")] }] }]);
});

test("things people type stay as typed", () => {
  for (const s of ["snake_case_name", "2*3*4 = 24", "a * b * c", "file__name__v2", "~/projects", "* bullet", "me_", "~ approx 5", "price: 5*", "||", "**", "``", "[]()", ">_<", "x|y||z"])
    assert.deepEqual(p(s), [T(s)], s);
  assert.equal(hasMarkdown("snake_case_name"), false);
  assert.equal(hasMarkdown("*yes*"), true);
});

test("escapes", () => {
  assert.deepEqual(p("\\*not bold\\*"), [T("*not bold*")]);
  assert.deepEqual(p("back\\\\slash"), [T("back\\slash")]);
  assert.deepEqual(p("C:\\Users"), [T("C:\\Users")]);
});

test("links: only http / https / mailto / tel", () => {
  assert.deepEqual(p("[site](https://example.com/a)"), [{ t: "link", href: "https://example.com/a", c: [T("site")] }]);
  assert.deepEqual(p("[mail](mailto:a@b.co)")[0], { t: "link", href: "mailto:a@b.co", c: [T("mail")] });
  assert.deepEqual(p("[call](tel:+15555550100)")[0], { t: "link", href: "tel:+15555550100", c: [T("call")] });
  assert.deepEqual(p("[x](example.com)")[0], { t: "link", href: "https://example.com/", c: [T("x")] });
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vbscript:x", "intent://x", "java\nscript:alert(1)", "https://", "//evil.com"])
    assert.ok(!p(`[x](${bad})`).some((n) => n.t === "link"), bad);
  assert.equal(safeHref(" javascript:alert(1)"), null);
  assert.equal(safeHref("https://ok.com/\u0000"), null);
});

test("quotes", () => {
  assert.deepEqual(p("> quoted *line*\n> two\nafter"), [{ t: "quote", c: [T("quoted "), { t: "b", c: [T("line")] }, T("\ntwo")] }, T("after")]);
  assert.deepEqual(p("before\n> q"), [T("before"), { t: "quote", c: [T("q")] }]);
  assert.deepEqual(p("```\n> not a quote\n```"), [{ t: "pre", v: "> not a quote" }]);
});

test("plainText masks spoilers and drops markers", () => {
  assert.equal(plainText("*hi* ||secret|| `x`"), "hi ▒▒▒▒▒▒ x");
  assert.equal(plainText("||secret||", { spoiler: "keep" }), "secret");
});

test("toggleStyle wraps / unwraps; wrapLink is safe", () => {
  assert.deepEqual(toggleStyle("hello world", 6, 11, "b"), { text: "hello *world*", start: 7, end: 12 });
  assert.deepEqual(toggleStyle("hello *world*", 7, 12, "b"), { text: "hello world", start: 6, end: 11 });
  assert.deepEqual(toggleStyle("hello *world*", 6, 13, "b"), { text: "hello world", start: 6, end: 11 });
  assert.deepEqual(toggleStyle("say hi ", 4, 7, "sp"), { text: "say ||hi|| ", start: 6, end: 8 }, "selection trimmed");
  assert.deepEqual(toggleStyle("ab", 1, 1, "code"), { text: "a``b", start: 2, end: 2 });
  assert.equal(wrapLink("go here", 3, 7, "javascript:alert(1)"), null);
  assert.deepEqual(wrapLink("go here", 3, 7, "example.com"), { text: "go [here](example.com)", start: 22, end: 22 });
  assert.deepEqual(p(wrapLink("go here", 3, 7, "example.com")!.text)[1], { t: "link", href: "https://example.com/", c: [T("here")] });
});

test("pathological input stays fast", () => {
  const s = "*_~||`[".repeat(2000);
  const t0 = Date.now();
  p(s);
  p("*a ".repeat(3000));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});
