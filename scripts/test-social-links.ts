// Unit tests for src/lib/socialLinks.ts. Run: npx tsx scripts/test-social-links.ts
import { socialFormState, normalizeSocial, normalizeSocialLinks, sanitizeStoredLinks, socialDisplay, type SocialKey } from "../src/lib/socialLinks";

let fail = 0;
const eq = (k: SocialKey, input: unknown, want: string | null | "ERR") => {
  const r = normalizeSocial(k, input);
  const got = r.ok ? r.value : "ERR";
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${k} ${JSON.stringify(input)} → ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
};

eq("instagram", "@donny.dey", "https://instagram.com/donny.dey");
eq("instagram", "https://www.instagram.com/donny_dey/?hl=en", "https://instagram.com/donny_dey");
eq("instagram", "instagram.com/donny", "https://instagram.com/donny");
eq("instagram", "bad..name", "ERR");
eq("instagram", "https://evil.com/donny", "ERR");
eq("instagram", "a".repeat(31), "ERR");
eq("x", "@jack", "https://x.com/jack");
eq("x", "https://twitter.com/jack/status/1", "https://x.com/jack");
eq("x", "mobile.twitter.com/jack", "https://x.com/jack");
eq("x", "toolonghandle12345", "ERR");
eq("x", "bad-handle", "ERR");
eq("tiktok", "@some.one", "https://www.tiktok.com/@some.one");
eq("tiktok", "https://www.tiktok.com/@some.one?lang=en", "https://www.tiktok.com/@some.one");
eq("tiktok", "https://www.tiktok.com/some.one", "https://www.tiktok.com/@some.one");
eq("youtube", "@MrBeast", "https://www.youtube.com/@MrBeast");
eq("youtube", "https://m.youtube.com/@MrBeast/videos", "https://www.youtube.com/@MrBeast");
eq("linkedin", "https://www.linkedin.com/in/donny-dey/", "https://www.linkedin.com/in/donny-dey");
eq("linkedin", "donny-dey", "https://www.linkedin.com/in/donny-dey");
eq("linkedin", "https://linkedin.com/company/x", "ERR");
eq("snapchat", "donnyd", "https://snapchat.com/add/donnyd");
eq("snapchat", "https://www.snapchat.com/add/donnyd", "https://snapchat.com/add/donnyd");
eq("snapchat", "1abc", "ERR");
eq("telegram", "@durov", "https://t.me/durov");
eq("telegram", "https://t.me/durov", "https://t.me/durov");
eq("telegram", "t.me/durov", "https://t.me/durov");
eq("telegram", "abc", "ERR");
eq("threads", "@zuck", "https://www.threads.net/@zuck");
eq("threads", "https://www.threads.net/@zuck", "https://www.threads.net/@zuck");
eq("threads", "https://www.threads.com/@zuck", "https://www.threads.net/@zuck");
eq("website", "example.com", "https://example.com/");
eq("website", "https://example.com/about", "https://example.com/about");
eq("website", "http://example.com", "https://example.com/");
eq("website", "javascript:alert(1)", "ERR");
eq("website", "https://user:pw@example.com", "ERR");
eq("website", "https://localhost", "ERR");
eq("website", "https://example.com:8443", "ERR");
eq("website", "https://exa mple.com", "ERR");
eq("website", `https://example.com/${"a".repeat(200)}`, "ERR");
eq("website", "https://example.com/\"><script>", "ERR");
eq("x", "", null);
eq("x", "   ", null);
eq("x", null, null);
eq("x", 42, "ERR");

const check = (c: boolean, label: string) => (console.log(`${c ? "✓" : "✗"} ${label}`), c || fail++);
const m = normalizeSocialLinks({ x: "@a_b", instagram: "", bogus: "x" }, { instagram: "https://instagram.com/old", youtube: "https://www.youtube.com/@yt1" });
check(m.ok && JSON.stringify(m.links) === JSON.stringify({ youtube: "https://www.youtube.com/@yt1", x: "https://x.com/a_b" }), "partial merge: set, clear, keep, drop unknown");
const bad = normalizeSocialLinks({ x: "no way", website: "ftp://a.com" });
check(!bad.ok && !!bad.errors.x && !!bad.errors.website, "per-field errors");
check(!normalizeSocialLinks("nope").ok && !normalizeSocialLinks([]).ok, "non-object rejected");
check(JSON.stringify(sanitizeStoredLinks({ x: "javascript:1", website: "https://ok.dev/", z: "https://a.b" })) === JSON.stringify({ website: "https://ok.dev/" }), "stored data sanitized");
check(socialDisplay("x", "https://x.com/jack") === "@jack" && socialDisplay("website", "https://ok.dev/") === "ok.dev", "display text");

// Save-button regression: form state
eq("website", "http://a.com", "https://a.com/");
eq("website", "a.com", "https://a.com/");
eq("instagram", "  @Donny.Dey  ", "https://instagram.com/Donny.Dey");
eq("x", "x.com/jack/", "https://x.com/jack");
eq("x", "HTTPS://X.COM/jack", "https://x.com/jack");
const empty = {};
check(socialFormState({}, empty).canSave === false, "form: untouched → disabled");
check(socialFormState({ instagram: "@donny" }, empty).canSave, "form: @handle → enabled");
check(socialFormState({ x: "donnydey" }, empty).canSave, "form: bare handle → enabled");
check(socialFormState({ x: "https://x.com/donnydey/" }, empty).canSave, "form: URL w/ trailing slash → enabled");
check(socialFormState({ website: "example.com" }, empty).canSave, "form: website w/o scheme → enabled");
check(socialFormState({ instagram: "@donny" }, empty, { instagram: undefined }).canSave, "form: cleared server error (undefined key) does not block save");
const inv = socialFormState({ instagram: "@donny", x: "bad handle!" }, empty);
check(!inv.canSave && !!inv.errors.x && !inv.errors.instagram, "form: invalid field → disabled with that field's message");
const saved = { x: "https://x.com/jack" };
check(!socialFormState({ x: "@jack" }, saved).dirty, "form: same value in other form → not dirty");
check(socialFormState({ x: "" }, saved).canSave, "form: clearing a saved link → enabled");
check(!socialFormState({ x: "@jill" }, saved, { x: "server says no" }).canSave, "form: server error blocks");

console.log(fail ? `FAILED (${fail})` : "PASSED");
process.exit(fail ? 1 : 0);
