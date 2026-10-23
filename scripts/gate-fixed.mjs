#!/usr/bin/env node
// gate:fixed — every past fix in docs/fixed-registry.csv must still pass its verifying test. Run before ANY deploy.
// Usage: npm run gate:fixed [-- --no-render]   (render tests need Playwright Chromium + ffmpeg)
// Env: TEST_DATABASE_URL (default postgresql://ua@127.0.0.1:55433/ol_hardening_test), GATE_JOBS (unused, serial).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const noRender = process.argv.includes("--no-render");
const env = { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || "postgresql://ua@127.0.0.1:55433/ol_hardening_test", GATE: "1" };
const parse = (line) => { const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
const [head, ...lines] = readFileSync("docs/fixed-registry.csv", "utf8").trim().split("\n");
const cols = parse(head);
const rows = lines.map((l) => Object.fromEntries(parse(l).map((v, i) => [cols[i], v])));
let fail = 0;
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };

// 1. integrity: test file exists, fix commit is in this tree's history
const inGit = spawnSync("git", ["rev-parse", "HEAD"]).status === 0;
for (const r of rows) {
  if (!existsSync(r.verifying_test)) bad(`${r.id} test missing: ${r.verifying_test}`);
  if (inGit && spawnSync("git", ["merge-base", "--is-ancestor", r.fix_commit, "HEAD"]).status !== 0) bad(`${r.id} fix commit ${r.fix_commit} is not in HEAD's history (fix reverted or not merged)`);
}

// 2. run each verifying test once; rows with a pattern must have that test passing
const files = [...new Set(rows.map((r) => r.verifying_test))];
const out = {};
for (const f of files) {
  const render = /\.render\.mts$/.test(f);
  if (render && noRender) { console.log(`SKIP  ${f} (--no-render)`); continue; }
  const args = render ? ["--import", "tsx", f] : ["--import", "tsx", "--test", "--test-force-exit", "--test-concurrency=1", "--test-timeout=120000", "--test-reporter=tap", f];
  const t0 = Date.now();
  const p = spawnSync(process.execPath, args, { env, encoding: "utf8", maxBuffer: 64 << 20, timeout: 15 * 60_000 });
  out[f] = (p.stdout || "") + (p.stderr || "");
  const ids = rows.filter((r) => r.verifying_test === f).map((r) => r.id).join(" ");
  if (p.status === 0) console.log(`PASS  ${f} [${ids}] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  else bad(`${f} [${ids}] exit ${p.status}\n${out[f].split("\n").filter((l) => /not ok|Error|GATE FAIL|assert/i.test(l)).slice(0, 12).join("\n")}`);
}
for (const r of rows.filter((r) => r.test_name_pattern && out[r.verifying_test] !== undefined)) {
  const okLine = out[r.verifying_test].split("\n").some((l) => /^\s*ok \d+ - /.test(l) && l.includes(r.test_name_pattern));
  if (!okLine) bad(`${r.id} no passing test matching "${r.test_name_pattern}" in ${r.verifying_test}`);
}
console.log(`\ngate:fixed ${rows.length} fixes, ${files.length} tests — ${fail ? `FAILED (${fail})` : "PASSED"}`);
process.exit(fail ? 1 : 0);
