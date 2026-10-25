// FX-081 per-call telemetry summary from Railway logs (read-only).
// Usage: railway logs --json ... | npx tsx scripts/call-telemetry-summary.ts <callId-prefix>
import { createInterface } from "node:readline";
import { summarize, type TelemetryRow } from "../server/calls/telemetry";

const want = process.argv[2] ?? "";
const rows: TelemetryRow[] = [];
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const i = line.indexOf("{");
  if (i < 0 || !line.includes("[calls] telemetry")) return;
  let rec: any;
  try { rec = JSON.parse(line.slice(i)); } catch { return; }
  const f = rec.fields ?? rec;
  if (!String(f.callId ?? "").startsWith(want)) return;
  const t = Date.parse(rec.ts ?? rec.timestamp ?? "") || 0;
  for (const s of f.s ?? []) rows.push({ src: f.src, user: s.user ?? f.user ?? "?", t, platform: f.platform, net: f.net, ...s });
});
rl.on("close", () => {
  const out = summarize(rows);
  if (!out.length) return console.log(`no telemetry rows for "${want}"`);
  console.table(out.map(({ from, to, ...r }) => ({ ...r, secs: Math.round((to - from) / 1000) })));
});
