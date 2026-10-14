import { test } from "node:test";
import assert from "node:assert/strict";
import { inputKeys, shouldReacquireMic, followAudioDevices } from "../../src/lib/audioDevices";
const dev = (deviceId: string, kind: MediaDeviceKind = "audioinput", label = "") => ({ deviceId, kind, label, groupId: "", toJSON() {} }) as MediaDeviceInfo;

test("inputKeys: audio inputs only, ignores default/communications aliases, label fallback", () => {
  assert.deepEqual(inputKeys([dev("default"), dev("communications"), dev("b"), dev("a"), dev("x", "audiooutput"), dev("", "audioinput", "Headset Mic")]), ["Headset Mic", "a", "b"]);
});
test("headset plugged in (wired / USB-C / Bluetooth) => re-acquire to use the headset mic", () => {
  assert.deepEqual(shouldReacquireMic(["builtin"], ["builtin", "bt-airpods"]), { reacquire: true, reason: "added" });
  assert.deepEqual(shouldReacquireMic(["builtin"], ["builtin", "usb-c"], "default"), { reacquire: true, reason: "added" });
});
test("headset removed => fall back to the phone mic", () => {
  assert.deepEqual(shouldReacquireMic(["builtin", "wired"], ["builtin"], "wired"), { reacquire: true, reason: "current-gone" });
  assert.deepEqual(shouldReacquireMic(["builtin", "wired"], ["builtin"], "default"), { reacquire: true, reason: "removed" });
});
test("output-only change or first snapshot never restarts the mic", () => {
  assert.deepEqual(shouldReacquireMic(["builtin"], ["builtin"]), { reacquire: false, reason: null });
  assert.deepEqual(shouldReacquireMic(null, ["builtin", "bt"]), { reacquire: false, reason: null });
});
test("followAudioDevices debounces devicechange bursts and reports once", async () => {
  let devices = [dev("builtin")]; const ls = new Set<() => void>();
  (globalThis as any).navigator = { mediaDevices: { enumerateDevices: async () => devices, addEventListener: (_: string, f: () => void) => ls.add(f), removeEventListener: (_: string, f: () => void) => ls.delete(f) } };
  const got: string[] = []; const stop = followAudioDevices((r) => got.push(r), () => "default", 20);
  await new Promise((r) => setTimeout(r, 5));
  devices = [dev("builtin"), dev("bt")]; for (let i = 0; i < 4; i++) for (const f of ls) f();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got, ["added"]);
  devices = [dev("builtin")]; for (const f of ls) f(); await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got, ["added", "removed"]);
  stop(); assert.equal(ls.size, 0);
});
