// Sponsored messages: validation, OFF-by-default, schedule/placement/group-size selection, hide/report.
// Runs against the JSON store (temp DATA_DIR) and, when HX_TEST_DATABASE_URL is set (migrations ≤ 021), Postgres too.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

type Sp = typeof import("../../server/sponsored");
const PG = process.env.HX_TEST_DATABASE_URL;
let sp: Sp;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sp-"));
  sp = await import("../../server/sponsored");
});

const base = { advertiser: "Acme", title: "Try Acme", body: "Hello", ctaLabel: "Open", ctaUrl: "https://acme.example/x", placements: ["rooms"] as ("rooms" | "groups")[] };

test("validate: https only, required fields, placements, schedule order", () => {
  assert.equal(sp.validate({ ...base, ctaUrl: "http://acme.example" }, false).ok, false);
  assert.equal(sp.validate({ ...base, ctaUrl: "javascript:alert(1)" }, false).ok, false);
  assert.equal(sp.validate({ ...base, ctaUrl: "https://u:p@acme.example" }, false).ok, false);
  assert.equal(sp.validate({ ...base, title: "  " }, false).ok, false);
  assert.equal(sp.validate({ ...base, placements: ["dms" as "rooms"] }, false).ok, false);
  assert.equal(sp.validate({ ...base, startsAt: 2000, endsAt: 1000 }, false).ok, false);
  const ok = sp.validate({ ...base, title: "Bad\u202Etitle", minGroupSize: 1 }, false);
  assert.ok(ok.ok && ok.v.title === "Badtitle" && ok.v.minGroupSize === 10);
  const partial = sp.validate({ enabled: true }, true);
  assert.ok(partial.ok && partial.v.enabled === true && partial.v.title === undefined);
});

async function scenario(label: string, s: ReturnType<Sp["store"]>) {
  const P = `sp_t${Date.now().toString(36)}${label}`;
  const id = (k: string) => `${P}${k}`;
  await s.setEnabled(false);
  await s.upsert(id("a"), { ...base, minGroupSize: 100, startsAt: Date.now() - 1000 }, "admin");
  // new ads start disabled; master switch off → nothing
  assert.equal(await sp.pickAd("u1", "rooms", 0), null, `${label}: off by default`);
  await s.upsert(id("a"), { enabled: true }, "admin");
  assert.equal(await sp.pickAd("u1", "rooms", 0), null, `${label}: master switch still off`);
  await s.setEnabled(true);
  assert.equal((await sp.pickAd("u1", "rooms", 0))?.id, id("a"), `${label}: shown when both on`);
  assert.equal(await sp.pickAd("u1", "groups", 500), null, `${label}: rooms-only ad not in groups`);
  // groups placement respects min size
  await s.upsert(id("a"), { placements: ["groups"] }, "admin");
  assert.equal(await sp.pickAd("u1", "groups", 99), null, `${label}: small group`);
  assert.equal((await sp.pickAd("u1", "groups", 100))?.id, id("a"), `${label}: large group`);
  // schedule
  await s.upsert(id("a"), { startsAt: Date.now() + 60_000 }, "admin");
  assert.equal(await sp.pickAd("u1", "groups", 500), null, `${label}: scheduled in future`);
  await s.upsert(id("a"), { startsAt: Date.now() - 120_000, endsAt: Date.now() - 60_000 }, "admin");
  assert.equal(await sp.pickAd("u1", "groups", 500), null, `${label}: ended`);
  await s.upsert(id("a"), { endsAt: null }, "admin");
  // hide/report are per user
  await s.hide("u1", id("a"));
  assert.equal(await sp.pickAd("u1", "groups", 500), null, `${label}: hidden for u1`);
  assert.equal((await sp.pickAd("u2", "groups", 500))?.id, id("a"), `${label}: still shown to u2`);
  await s.report("u2", id("a"), "scam");
  assert.equal(await sp.pickAd("u2", "groups", 500), null, `${label}: report hides`);
  // version bumps → image URLs change (cache-busting)
  const before = (await s.get(id("a")))!.version;
  await s.upsert(id("a"), { title: "New" }, "admin");
  assert.equal((await s.get(id("a")))!.version, before + 1);
  await s.upsert(id("a"), { enabled: false }, "admin");
  await s.remove(id("a"));
  assert.equal(await s.get(id("a")), null);
  await s.setEnabled(false);
}

test("JSON store: off by default, selection, hide/report", async () => {
  delete process.env.DATABASE_URL;
  await scenario("j", sp.store());
});

(PG ? test : test.skip)("Postgres store: off by default, selection, hide/report", async () => {
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  const sql = fs.readFileSync(path.join(__dirname, "../../server/migrations/021_sponsored.sql"), "utf8");
  await c.query(sql); // idempotent
  await c.query(sql);
  const was = (await c.query("SELECT value FROM sponsored_settings WHERE key='enabled'")).rows[0]?.value;
  assert.equal(was, "off");
  await c.end();
  process.env.DATABASE_URL = PG;
  try {
    await scenario("p", sp.store());
  } finally {
    delete process.env.DATABASE_URL;
  }
});
