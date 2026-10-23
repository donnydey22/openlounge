#!/usr/bin/env node
// Post-deploy check for openlounge.app/download (read-only): page renders for desktop + mobile UAs with the current
// labels, the latest APK (and the 0.3.19 fallback) download with 200 + matching sha256, and the APK signer matches
// ANDROID_SIGNER_SHA256 when apksigner + java are available (APKSIGNER=/path/apksigner).
// Usage: node --import tsx scripts/verify-download.mjs [base=https://openlounge.app]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ANDROID_FALLBACK, ANDROID_RELEASE, ANDROID_SIGNER_SHA256, IOS_FALLBACK, IOS_RELEASE, binaryUrl, releaseLabel } from "../src/lib/releases.ts";

const base = process.argv[2] || "https://openlounge.app";
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const UAS = { desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15", iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1", android: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" };
for (const [k, ua] of Object.entries(UAS)) {
  const r = await fetch(`${base}/download`, { headers: { "user-agent": ua } });
  const html = await r.text();
  ok(r.status === 200 && html.includes(releaseLabel(ANDROID_RELEASE)) && html.includes(releaseLabel(IOS_RELEASE)), `/download (${k}) ${r.status}, labels Android ${releaseLabel(ANDROID_RELEASE)} / iOS ${releaseLabel(IOS_RELEASE)}`);
}
const tmp = mkdtempSync(path.join(tmpdir(), "oldl-"));
for (const rel of [ANDROID_RELEASE, ANDROID_FALLBACK, IOS_RELEASE, IOS_FALLBACK]) {
  const r = await fetch(`${base}${rel.file}`, { redirect: "follow" });
  const h = createHash("sha256");
  const out = path.join(tmp, path.basename(rel.file));
  const ws = createWriteStream(out);
  let n = 0;
  for await (const chunk of r.body) { h.update(chunk); n += chunk.length; ws.write(chunk); }
  await new Promise((res) => ws.end(res));
  const sha = h.digest("hex");
  ok(r.status === 200 && sha === rel.sha256, `${rel.file} ${r.status}, ${n} B, sha256 ${sha.slice(0, 16)}… ${sha === rel.sha256 ? "matches" : `!= ${rel.sha256.slice(0, 16)}…`}`);
  const as = process.env.APKSIGNER;
  if (as && rel.file.endsWith(".apk")) {
    const v = spawnSync(as, ["verify", "--print-certs", out], { encoding: "utf8" });
    const d = (v.stdout.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/) || [])[1];
    ok(d === ANDROID_SIGNER_SHA256, `${rel.file} signer ${d ? d.slice(0, 16) + "…" : "?"} ${d === ANDROID_SIGNER_SHA256 ? "= release key" : "!= release key"}`);
  }
}
{
  const r = await fetch(`${base}/downloads/openlounge-ios.plist`);
  const xml = await r.text();
  ok(r.status === 200 && xml.includes(binaryUrl(IOS_RELEASE.file)) && xml.includes(`<string>${IOS_RELEASE.bundleId}</string>`), `/downloads/openlounge-ios.plist ${r.status} -> ${binaryUrl(IOS_RELEASE.file).split("/").pop()}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `verify-download FAILED (${fail})` : "verify-download PASSED");
process.exit(fail ? 1 : 0);
