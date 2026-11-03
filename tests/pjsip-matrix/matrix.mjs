// Must-pass call matrix (PLAN §11). 3 platforms x 3 platforms x {audio,video} x both directions = 36 cells.
// Each harness (pjsua loopback, XCUITest, Android instrumented, Playwright) writes results/<id>.json:
// { id, pass, rms|fps, srtpErr, teardownClean, redialPass, run }. `--gate` exits 1 unless all 36 pass.
import fs from "node:fs";
import path from "node:path";
export const PLATFORMS = ["iphone", "android", "browser"];
export const route = (a, b) => (a === "browser" || b === "browser" ? "sfu" : "p2p"); // Donny 12:37 AM
export function cells() {
  const out = [];
  for (const caller of PLATFORMS) for (const callee of PLATFORMS) for (const media of ["audio", "video"])
    for (const dir of ["caller->callee", "callee->caller"])
      out.push({ id: `${caller}-${callee}-${media}-${dir === "caller->callee" ? "fwd" : "rev"}`, caller, callee, media, dir, route: route(caller, callee),
        criteria: media === "audio" ? { rmsMin: 0.05, seconds: 30 } : { fpsMin: 15, nonBlack: true, seconds: 30, codec: ["H264", "AV1"] } });
  return out;
}
export function evaluate(dir) {
  return cells().map((c) => { const f = path.join(dir, `${c.id}.json`);
    if (!fs.existsSync(f)) return { ...c, status: "pending" };
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    const ok = r.pass === true && r.srtpErr === 0 && r.teardownClean === true && r.redialPass === true;
    return { ...c, status: ok ? "pass" : "fail", run: r.run }; });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv.find((a) => a.startsWith("--results="))?.slice(10) ?? "tests/pjsip-matrix/results";
  const rows = evaluate(dir); const n = (s) => rows.filter((r) => r.status === s).length;
  const md = ["| cell | route | status | run |", "|---|---|---|---|", ...rows.map((r) => `| ${r.id} | ${r.route} | ${r.status} | ${r.run ?? ""} |`),
    "", `pass ${n("pass")} / fail ${n("fail")} / pending ${n("pending")} of ${rows.length}`].join("\n");
  console.log(md); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  if (process.argv.includes("--gate") && n("pass") !== rows.length) { console.error("SHIP GATE: not every cell passes"); process.exit(1); }
}
