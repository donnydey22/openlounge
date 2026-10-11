import { test } from "node:test";
import assert from "node:assert/strict";
import { applyValidators, fileEtag, notModifiedHeaders } from "../../server/media/conditional";
const stat = { size: 12345, mtimeMs: 1_760_000_000_123, mtime: new Date(1_760_000_000_123) };
const req = (h: Record<string, string>) => ({ headers: h }) as never;
test("media conditional GET: ETag/Last-Modified set, If-None-Match / If-Modified-Since → 304, mismatch → 200", () => {
  const h: Record<string, string> = { "Content-Type": "image/webp", "Cache-Control": "private, max-age=60" };
  assert.equal(applyValidators(req({}), stat, h), false);
  assert.equal(h.ETag, fileEtag(stat));
  assert.ok(h["Last-Modified"]);
  assert.equal(applyValidators(req({ "if-none-match": `"x", ${fileEtag(stat)}` }), stat, {}), true);
  assert.equal(applyValidators(req({ "if-none-match": `W/${fileEtag(stat)}` }), stat, {}), true);
  assert.equal(applyValidators(req({ "if-none-match": `"nope"` }), stat, {}), false);
  assert.equal(applyValidators(req({ "if-modified-since": stat.mtime.toUTCString() }), stat, {}), true);
  assert.equal(applyValidators(req({ "if-modified-since": new Date(0).toUTCString() }), stat, {}), false);
  // INM wins over IMS
  assert.equal(applyValidators(req({ "if-none-match": `"nope"`, "if-modified-since": stat.mtime.toUTCString() }), stat, {}), false);
  const n = notModifiedHeaders({ ...h, "Content-Length": "5" });
  assert.equal(n["Content-Length"], undefined);
  assert.equal(n["Content-Type"], undefined);
  assert.equal(n.ETag, h.ETag);
});
