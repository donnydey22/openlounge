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

test("FX-registry: every fixed-registry row names an existing verifying test", () => {
  const rows = R("docs/fixed-registry.csv").trim().split("\n").slice(1);
  assert.ok(rows.length >= 25, `registry has ${rows.length} rows`);
  for (const line of rows) {
    const file = line.match(/(tests\/[^,"]+\.(?:test\.(?:ts|mjs)|render\.mts))/)?.[1];
    assert.ok(file && existsSync(file), `row without an existing test: ${line.slice(0, 80)}`);
  }
});
