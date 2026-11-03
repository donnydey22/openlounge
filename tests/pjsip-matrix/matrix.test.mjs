import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { cells, evaluate } from "./matrix.mjs";
test("36 unique cells, every pairing both ways, audio+video, browser legs via SFU", () => {
  const c = cells(); assert.equal(c.length, 36); assert.equal(new Set(c.map((x) => x.id)).size, 36);
  assert.equal(c.filter((x) => x.media === "video").length, 18);
  assert.ok(c.filter((x) => x.caller === "browser" || x.callee === "browser").every((x) => x.route === "sfu"));
  assert.ok(c.filter((x) => x.caller !== "browser" && x.callee !== "browser").every((x) => x.route === "p2p"));
});
test("a cell passes only with media + srtpErr 0 + clean teardown + redial", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "m"));
  fs.writeFileSync(path.join(d, "android-iphone-audio-fwd.json"), JSON.stringify({ pass: true, srtpErr: 0, teardownClean: true, redialPass: true }));
  fs.writeFileSync(path.join(d, "android-iphone-audio-rev.json"), JSON.stringify({ pass: true, srtpErr: 0, teardownClean: true, redialPass: false }));
  const r = Object.fromEntries(evaluate(d).map((x) => [x.id, x.status]));
  assert.equal(r["android-iphone-audio-fwd"], "pass"); assert.equal(r["android-iphone-audio-rev"], "fail"); assert.equal(r["iphone-iphone-video-fwd"], "pending");
});
