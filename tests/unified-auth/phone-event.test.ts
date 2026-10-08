// Anonymous phone-auth diagnostics: accepted, sanitized, never echo/log a phone number.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTestEnv, startApp, wipeDb, api, type App } from "./harness";

setTestEnv({ providers: true });
let app: App;
before(async () => {
  await wipeDb();
  app = await startApp();
});
after(async () => app?.close());

test("phone event is logged sanitized, without the number", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => (lines.push(a.map(String).join(" ")), orig(...a));
  try {
    const r = await api(app.base, "/auth/phone/event", { stage: "send", outcome: "captcha-check-failed", ms: 31234.6, challenge: true, path: "web", cc: "+1", phone: "+14155550123" });
    assert.equal(r.status, 200);
    const bad = await api(app.base, "/auth/phone/event", { stage: "<x>", outcome: "+14155550123", cc: "+14155550123" });
    assert.equal(bad.status, 200);
  } finally {
    console.log = orig;
  }
  const ev = lines.filter((l) => l.includes("phone auth event")).map((l) => JSON.parse(l));
  assert.equal(ev.length, 2);
  assert.deepEqual({ ...ev[0], ts: 0, platform: 0 }, { ts: 0, level: "info", msg: "phone auth event", stage: "send", outcome: "captcha-check-failed", ms: 31235, challenge: true, path: "web", cc: "+1", platform: 0 });
  assert.equal(ev[1].stage, "other");
  assert.equal(ev[1].outcome, "other");
  assert.equal(ev[1].cc, null);
  assert.ok(!lines.join("\n").includes("4155550123"));
});
