import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const validate = (min, max) =>
  spawnSync("bash", ["deploy/validate-pilot-range.sh", String(min), String(max)], { encoding: "utf8" });

test("accepts only the explicitly reviewed first-pilot UDP envelope", () => {
  assert.equal(validate(40000, 49999).status, 0);
});

test("refuses low ports, coturn listener overlap, and coturn relay overlap before any firewall operation", () => {
  for (const [min, max] of [[1, 4000], [3000, 40000], [3478, 49999], [49999, 50000], [50000, 60000]]) {
    const result = validate(min, max);
    assert.equal(result.status, 2, `${min}-${max}: ${result.stderr}`);
  }
});
