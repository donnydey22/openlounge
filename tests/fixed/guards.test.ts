// Regression guards for past fixes that had no automated test of their own (see docs/fixed-registry.csv).
// Static checks against the shipped source: cheap, deterministic, and they fail loudly if a fix is reverted.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const R = (p: string) => readFileSync(path.resolve(p), "utf8");
function walk(dir: string, out: string[] = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

test("FX-auth-recaptcha-host: reCAPTCHA host lives directly under <body>, top z-index, scroll unlocked while verifying", () => {
  const fc = R("src/lib/firebaseClient.ts");
  assert.match(fc, /host\.parentElement !== document\.body/);
  assert.match(fc, /document\.body\.appendChild\(host\)/);
  assert.match(fc, /ol-recaptcha-active/);
  assert.match(R("src/app/globals.css"), /\.ol-recaptcha-host\s*\{[^}]*z-index:\s*2147483647/);
});

test("FX-safari-lookbehind: no lookbehind regex literals in client code (parse error on Safari < 16.4 took down the root layout)", () => {
  const bad = walk("src").filter((f) => /\/(?<!\\)\(\?<[=!]/.test(readFileSync(f, "utf8")) || /new RegExp\([^)]*\(\?<[=!]/.test(readFileSync(f, "utf8")));
  assert.deepEqual(bad, []);
});

test("FX-chat-sticker-reply-right: my sticker / big-emoji replies stay on the right edge (PR #55 regression)", () => {
  assert.match(R("src/components/chat/DmThread.tsx"), /\(sticker \|\| parts\) && m\.replyTo && mine && "flex flex-col items-end"/);
  assert.match(R("src/components/chat/RoomChatPanel.tsx"), /className=\{m\.replyTo && mine \? "ml-auto" : undefined\}/);
});

test("FX-web-404: app-styled 404 page and /rooms + /profile aliases exist", () => {
  for (const f of ["src/app/not-found.tsx", "src/app/rooms/page.tsx", "src/app/profile/page.tsx"]) assert.ok(existsSync(f), f);
});

test("FX-download-latest: /download serves the latest Android build; label, file, sha256 and fallback are consistent", async () => {
  const r = await import("../../src/lib/releases");
  const a = r.ANDROID_RELEASE, f = r.ANDROID_FALLBACK;
  assert.equal(a.file, `/downloads/openlounge-${a.version}-${a.build}.apk`);
  assert.equal(f.file, `/downloads/openlounge-${f.version}-${f.build}.apk`);
  assert.ok(a.build > f.build, "latest build is newer than the fallback");
  assert.ok(r.IOS_RELEASE.build > r.IOS_FALLBACK.build, "latest iOS build is newer than the fallback");
  assert.equal(r.IOS_FALLBACK.file, `/downloads/openlounge-ios-${r.IOS_FALLBACK.version}-b${r.IOS_FALLBACK.build}.ipa`);
  for (const x of [a, f, r.IOS_RELEASE, r.IOS_FALLBACK]) assert.match(x.sha256, /^[0-9a-f]{64}$/);
  assert.match(r.ANDROID_SIGNER_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(r.IOS_RELEASE.file, `/downloads/openlounge-ios-${r.IOS_RELEASE.version}-b${r.IOS_RELEASE.build}.ipa`);
  assert.equal(r.binaryUrl(a.file), `${r.BINARY_HOST}/openlounge-${a.version}-${a.build}.apk`);
  assert.match(R("src/app/download/DownloadHub.tsx"), /ANDROID_RELEASE/);
});

test("FX-registry: every fixed-registry row names an existing verifying test", () => {
  const rows = R("docs/fixed-registry.csv").trim().split("\n").slice(1);
  assert.ok(rows.length >= 25, `registry has ${rows.length} rows`);
  for (const line of rows) {
    const file = line.match(/(tests\/[^,"]+\.(?:test\.(?:ts|mjs)|render\.mts))/)?.[1];
    assert.ok(file && existsSync(file), `row without an existing test: ${line.slice(0, 80)}`);
  }
});
