// Content filter (App Store 1.2): profanity masked, slurs rejected, no false positives on ordinary words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterText } from "../../server/moderation";

test("masks profanity, keeps the first letter", () => {
  const r = filterText("this is shit and FUCKING great");
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, "this is s*** and F****** great");
  assert.equal(r.ok && r.masked, true);
});

test("catches leetspeak and repeated letters", () => {
  const r = filterText("sh1ttt");
  assert.ok(r.ok && r.masked);
});

test("rejects slurs, including spaced out", () => {
  assert.equal(filterText("you f4gg0t").ok, false);
  assert.equal(filterText("n i g g e r").ok, false);
});

test("no false positives (Scunthorpe problem)", () => {
  for (const s of ["Scunthorpe classic assess cocktail Dickens shitake? no: shiitake", "pass the class", "Hello world 👋", "spice market", "therapist"]) {
    const r = filterText(s);
    assert.ok(r.ok, s);
    assert.equal(r.ok && r.text, s);
  }
});
