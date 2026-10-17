import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeMediaSession } from "../../src/lib/calls/nativeMediaSession";

test("native audio-only session rejects enableCamera so toggleCam shows 'Camera unavailable' instead of a silent black tile", async () => {
  await assert.rejects(NativeMediaSession.prototype.enableCamera.call({} as NativeMediaSession), /audio-only/);
});
