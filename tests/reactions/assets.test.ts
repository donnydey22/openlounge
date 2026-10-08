import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assetChain, bigEmoji, emojiKey, noteAssetFailure, resolveRemote } from "../../src/lib/emoji/assets";

test("emoji keys strip FE0F", () => {
  assert.equal(emojiKey("❤️"), "2764");
  assert.equal(emojiKey("❤"), "2764");
  assert.equal(emojiKey("👍🏽"), "1f44d_1f3fd");
});

test("chain: our Telegram copy → upstream file → our Noto copy; static skips upstream", async () => {
  const c = assetChain("🎉", "telegram");
  assert.deepEqual(c.map((s) => (s.type === "remote" ? "remote" : s.source)), ["telegram", "remote", "noto"]);
  assert.equal((c[0] as { src: string }).src, "/emoji/telegram/1f389.webp");
  assert.equal((c[2] as { src: string }).src, "/emoji/noto/1f389.json");
  const r = await resolveRemote(c[1] as { key: string; durationMs: number });
  assert.equal(r?.src, "https://raw.githubusercontent.com/Tarikul-Islam-Anik/Telegram-Animated-Emojis/main/Activity/Party%20Popper.webp");
  assert.deepEqual(assetChain("🎉", "telegram", false).map((s) => s.type), ["webp", "lottie"]);
  assert.deepEqual(assetChain("🎉", "noto").map((s) => (s.type === "remote" ? "remote" : s.source)), ["noto", "telegram", "remote"]);
});

test("gaps: skin tones (Telegram lacks) come from Noto; unknown → empty chain (native glyph)", () => {
  assert.deepEqual(assetChain("👍🏽").map((s) => s.type), ["lottie"]);
  assert.deepEqual(assetChain("🫨x"), []);
});

test("every catalog / key file is on disk", () => {
  const tg = JSON.parse(fs.readFileSync("public/emoji/telegram/manifest.json", "utf8"));
  const noto = JSON.parse(fs.readFileSync("public/emoji/noto/manifest.json", "utf8"));
  assert.equal(tg.count, 631);
  assert.equal(noto.count, 879);
  for (const k of Object.keys(tg.files)) assert.ok(fs.existsSync(`public/emoji/telegram/${k}.webp`) && fs.existsSync(`public/emoji/telegram/p/${k}.webp`), k);
  const cat = JSON.parse(fs.readFileSync("src/lib/emoji/catalog.json", "utf8"));
  for (const r of cat.rows) assert.ok(r[5] === "t" ? tg.files[r[1]] : noto.files[r[1]], `catalog ${r[0]} ${r[1]}`);
  for (const k of Object.keys(noto.files)) assert.ok(fs.existsSync(`public/emoji/noto/${k}.json`) && fs.existsSync(`public/emoji/noto/p/${k}.webp`), k);
});

test("session health: after 3 local failures the upstream file is tried first", () => {
  const first = assetChain("🔥")[0];
  for (let i = 0; i < 3; i++) noteAssetFailure(first);
  assert.equal(assetChain("🔥")[0].type, "remote");
});

test("big emoji detection", () => {
  assert.deepEqual(bigEmoji("🎉"), ["🎉"]);
  assert.deepEqual(bigEmoji("❤️ 🔥"), ["❤️", "🔥"]);
  assert.equal(bigEmoji("hi 🎉"), null);
  assert.equal(bigEmoji("🎉🎉🎉🎉"), null);
});
