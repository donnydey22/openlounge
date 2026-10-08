import { test } from "node:test";
import assert from "node:assert/strict";
import { linkify, firstPreviewableLink, punyDecode, type LinkToken } from "../../src/lib/linkify";

const links = (s: string) => linkify(s).filter((t): t is LinkToken => t.type === "link");

test("plain text stays text and round-trips exactly", () => {
  const s = "hello there, no links here: 3.14 and a.b";
  const toks = linkify(s);
  assert.equal(toks.map((t) => t.text).join(""), s);
  assert.equal(links(s).length, 0);
});

test("detects http(s), www and bare domains; trims punctuation; keeps balanced parens", () => {
  const s = "see https://example.com/a?b=1, www.example.org. openlounge.app! (https://en.wikipedia.org/wiki/Foo_(bar)).";
  const l = links(s);
  assert.deepEqual(
    l.map((t) => t.href),
    ["https://example.com/a?b=1", "https://www.example.org/", "https://openlounge.app/", "https://en.wikipedia.org/wiki/Foo_(bar)"],
  );
  assert.equal(linkify(s).map((t) => t.text).join(""), s, "text is preserved around links");
});

test("only http/https/mailto/tel ever become links", () => {
  for (const s of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "intent://scan/#Intent;scheme=zxing;end", "vbscript:msgbox(1)", "blob:https://x/y"]) {
    const l = links(s);
    for (const t of l) assert.match(t.href, /^(https?:|mailto:|tel:)/, s);
    assert.ok(!l.some((t) => /javascript|data:|file:|intent:|vbscript|blob:/i.test(t.href)), s);
  }
});

test("openlounge.app pages are internal (in-app), sensitive paths are not", () => {
  const [room, prof, auth, api] = links("https://openlounge.app/room/abc https://www.openlounge.app/profile/u_1 https://openlounge.app/auth/complete?code=x https://openlounge.app/api/me");
  assert.equal(room.kind, "internal");
  assert.equal(room.path, "/room/abc");
  assert.equal(prof.kind, "internal");
  assert.equal(auth.kind, "external", "auth callbacks never navigate in-app from a chat");
  assert.equal(api.kind, "external");
  assert.equal(links("https://openlounge.app:8443/room/abc")[0].kind, "external");
  assert.equal(links("https://user@openlounge.app/room/abc")[0].kind, "external");
});

test("look-alike, punycode, IP, userinfo and port warnings", () => {
  const w = (s: string) => links(s)[0].warnings.join(" | ");
  assert.match(w("https://xn--penlounge-x3a.app/login"), /special characters/);
  assert.match(w("https://аpple.com"), /Latin and Cyrillic/);
  assert.match(w("0penlounge.app"), /looks like openlounge\.app/);
  assert.match(w("https://openlounge.app.evil.example/"), /mentions Open Lounge/);
  assert.match(w("http://192.168.0.1/admin"), /IP address/);
  assert.match(w("https://openlounge.app@evil.example/"), /user name/);
  assert.match(w("https://example.com:8080/"), /port/);
  assert.equal(links("https://example.com/")[0].warnings.length, 0);
  assert.equal(links("https://github.com/")[0].warnings.length, 0);
});

test("email → mailto, phone → tel, no double match on the email domain", () => {
  const l = links("mail me at jo.doe+x@example.co.uk or call +1 (555) 123-4567");
  assert.deepEqual(l.map((t) => [t.kind, t.href]), [
    ["mailto", "mailto:jo.doe+x@example.co.uk"],
    ["tel", "tel:+15551234567"],
  ]);
});

test("long unbroken links survive and huge input is capped", () => {
  const long = "https://example.com/" + "a".repeat(5000);
  assert.equal(links(long)[0].href.length, long.length);
  assert.doesNotThrow(() => linkify("x".repeat(100000)));
});

test("punycode decoder", () => {
  const d = punyDecode("penlounge-x3a");
  assert.match(d, /penloung/);
  assert.match(d, /[^\x00-\x7f]/);
  assert.equal(punyDecode("mnchen-3ya"), "münchen");
});

test("preview only for clean external https links", () => {
  assert.equal(firstPreviewableLink("look https://example.com/x")?.href, "https://example.com/x");
  assert.equal(firstPreviewableLink("look http://example.com/x"), null);
  assert.equal(firstPreviewableLink("look https://0penlounge.app"), null);
  assert.equal(firstPreviewableLink("look https://openlounge.app/room/x"), null);
});

test("hashtags: unicode, >=1 letter, <=64, not in URLs/emails/code, lowercase-normalised", async () => {
  const { extractHashtags } = await import("../../src/lib/linkify");
  assert.deepEqual(extractHashtags("Live #Music tonight #café #日本 #123 #a_1 #x" + "y".repeat(70)), ["music", "café", "日本", "a_1"]);
  assert.deepEqual(extractHashtags("https://example.com/#anchor www.x.com/#y mail a#b@example.com"), []);
  assert.deepEqual(extractHashtags("code `#notatag` but #yes, and &#39; and word#no"), ["yes"]);
  assert.deepEqual(extractHashtags("#Tech #tech #TECH"), ["tech"]);
  const toks = linkify("hi #Rooms and https://openlounge.app/room/x #ok");
  assert.deepEqual(toks.filter((t) => t.type !== "text").map((t) => t.type), ["hashtag", "link", "hashtag"]);
  assert.equal(toks.map((t) => t.text).join(""), "hi #Rooms and https://openlounge.app/room/x #ok");
});

test("mentions: @screen_name 3-20, not in emails/URLs/code, lowercase; mixed with hashtags", async () => {
  const { extractMentions, extractHashtags } = await import("../../src/lib/linkify");
  assert.deepEqual(extractMentions("hi @Maya and @bob_1, mail maya@example.com, https://x.com/@maya `@code` @ab @" + "a".repeat(21)), ["maya", "bob_1"]);
  assert.deepEqual(extractMentions("@maya #music"), ["maya"]);
  assert.deepEqual(extractHashtags("@maya #music"), ["music"]);
  const toks = linkify("(@maya) #x");
  assert.deepEqual(toks.filter((t) => t.type !== "text").map((t) => t.type), ["mention", "hashtag"]);
});
