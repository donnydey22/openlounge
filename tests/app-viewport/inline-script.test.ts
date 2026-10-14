// The inline <head> script in layout.tsx is a template literal: it must survive escaping and be valid JS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("appViewportScript compiles and matches wrapper UAs only", () => {
  const src = readFileSync("src/app/layout.tsx", "utf8");
  const lit = /const appViewportScript = (`[^`]*`);/.exec(src)![1];
  const code: string = new Function(`return ${lit}`)();
  assert.doesNotThrow(() => new Function(code));
  const re = /\/OpenLounge\(.*?Expo\)\//.exec(code)![0];
  const rx = new Function(`return ${re}`)() as RegExp;
  assert.ok(rx.test("Mozilla/5.0 ... OpenLounge/android/0.3.6(18)"));
  assert.ok(rx.test("Mozilla/5.0 ... OpenLounge/ios/0.3.3"));
  assert.ok(!rx.test("Mozilla/5.0 (Macintosh) Chrome/155.0 Safari/537.36"));
});
