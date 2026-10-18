// Item 5 (Oct 18 2026): iPhone clips silent for receivers. The pipeline used to map 0:a:0 blindly; iPhone
// recordings can carry an extra spatial/undecodable or non-default track first.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pickAudio, probe, transcodeVideo } from "../../server/media/process";

test("pickAudio prefers a decodable, default, stereo track", () => {
  assert.equal(pickAudio([]), null);
  assert.deepEqual(pickAudio([{ codec_name: "aac", channels: 2 }]), { codec: "aac", index: 0 });
  assert.equal(pickAudio([{ codec_name: "apac", channels: 4, disposition: { default: 1 } }, { codec_name: "aac", channels: 2 }])!.index, 1);
  assert.equal(pickAudio([{ codec_name: "aac", channels: 4 }, { codec_name: "aac", channels: 2, disposition: { default: 1 } }])!.index, 1);
});

test("transcode keeps the real (default stereo) audio when a 4-channel track comes first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olaud-"));
  const src = path.join(dir, "in.mov");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=320x240:d=2", "-f", "lavfi", "-i", "anullsrc=cl=quad:r=48000", "-f", "lavfi", "-i", "sine=f=440:d=2",
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac:a:1", "2",
    "-disposition:a:0", "0", "-disposition:a:1", "default", src]);
  return probe(src).then(async (p) => {
    assert.equal(p.audio!.index, 1);
    await transcodeVideo(src, dir);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-i", path.join(dir, "full.mp4"), "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
    const m = /max_volume: (-?[\d.]+) dB/.exec(r.stderr);
    assert.ok(m && Number(m[1]) > -40, `output audio is silent: ${m?.[1]}`);
  });
});
