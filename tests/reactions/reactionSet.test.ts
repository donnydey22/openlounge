import { test } from "node:test";
import assert from "node:assert/strict";
import { REACTION_SET_KEY, readReactionSet, saveReactionSet } from "../../src/lib/emoji/reactionSet";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

test("reaction set: Google by default, remembers Fluent / Google, ignores anything else, separate from the composer tab", () => {
  store.clear();
  assert.equal(readReactionSet(), "google");
  saveReactionSet("fluent");
  assert.equal(readReactionSet(), "fluent");
  saveReactionSet("google");
  assert.equal(readReactionSet(), "google");
  store.set(REACTION_SET_KEY, "emoji");
  assert.equal(readReactionSet(), "google");
  assert.notEqual(REACTION_SET_KEY, "ol:emojiTab");
});

test("reaction set: storage that throws falls back to Google", () => {
  (globalThis as any).localStorage = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  assert.equal(readReactionSet(), "google");
  assert.doesNotThrow(() => saveReactionSet("fluent"));
});
