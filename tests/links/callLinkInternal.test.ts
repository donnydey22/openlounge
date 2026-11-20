// t6081u item 2: the tray link posted into a DM opens in-app (Meet-style join), not the "leaving Open Lounge" sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkify } from "../../src/lib/linkify";

test("openlounge.app/call/<id> is an internal in-app link", () => {
  const t = linkify("Join my Open Lounge Audio call: https://openlounge.app/call/7736e021-1271-4448-a3fb-342cf22eb772").find((x) => x.type === "link") as { kind: string; path?: string };
  assert.equal(t.kind, "internal");
  assert.equal(t.path, "/call/7736e021-1271-4448-a3fb-342cf22eb772");
  const ext = linkify("https://openlounge.app.evil.example/call/x").find((x) => x.type === "link") as { kind: string };
  assert.equal(ext.kind, "external");
});
