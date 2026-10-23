import test from "node:test";
import assert from "node:assert/strict";
import { kindFromIosPort, kindFromAndroidType, kindFromWebLabel, routeLabel, routeIcon, routeAnnouncement, routeFromNative, routesFromWebOutputs, defaultRoute, sortRoutes, isHeadsetKind } from "../../src/lib/calls/audioRoute";

test("iOS port types map to route kinds", () => {
  assert.equal(kindFromIosPort("Speaker"), "speaker");
  assert.equal(kindFromIosPort("Receiver"), "earpiece");
  assert.equal(kindFromIosPort("Headphones"), "wired");
  assert.equal(kindFromIosPort("BluetoothHFP"), "bluetooth");
  assert.equal(kindFromIosPort("BluetoothA2DPOutput"), "bluetooth");
  assert.equal(kindFromIosPort("BluetoothLE"), "bluetooth");
  assert.equal(kindFromIosPort("CarAudio"), "car");
  assert.equal(kindFromIosPort("USBAudio"), "usb");
});
test("Android AudioDeviceInfo types map to route kinds", () => {
  assert.equal(kindFromAndroidType(1), "earpiece"); // TYPE_BUILTIN_EARPIECE
  assert.equal(kindFromAndroidType(2), "speaker"); // TYPE_BUILTIN_SPEAKER
  assert.equal(kindFromAndroidType(3), "wired"); // TYPE_WIRED_HEADSET
  assert.equal(kindFromAndroidType(4), "wired"); // TYPE_WIRED_HEADPHONES
  assert.equal(kindFromAndroidType(7), "bluetooth"); // TYPE_BLUETOOTH_SCO
  assert.equal(kindFromAndroidType(8), "bluetooth"); // TYPE_BLUETOOTH_A2DP
  assert.equal(kindFromAndroidType(26), "bluetooth"); // TYPE_BLE_HEADSET
  assert.equal(kindFromAndroidType(22), "usb"); // TYPE_USB_HEADSET
});
test("web output labels", () => {
  assert.equal(kindFromWebLabel("AirPods Pro (Bluetooth)"), "bluetooth");
  assert.equal(kindFromWebLabel("MacBook Pro Speakers"), "speaker");
  assert.equal(kindFromWebLabel("External Headphones"), "wired");
});
test("labels and icons: Speaker / Phone / Headphones / device name", () => {
  assert.equal(routeLabel({ kind: "speaker", name: "" }), "Speaker");
  assert.equal(routeLabel({ kind: "earpiece", name: "" }), "Phone");
  assert.equal(routeLabel({ kind: "wired", name: "" }), "Headphones");
  assert.equal(routeLabel({ kind: "bluetooth", name: "Donny's AirPods Pro" }), "Donny's AirPods Pro");
  assert.ok(routeLabel({ kind: "bluetooth", name: "A very long Bluetooth headset product name" }).length <= 23);
  const icons = new Set(["speaker", "earpiece", "wired", "bluetooth"].map((k) => routeIcon(k as never)));
  assert.equal(icons.size, 4, "each route has a distinct icon");
});
test("announcement on change only", () => {
  const sp = { id: "speaker", kind: "speaker" as const, name: "" };
  const bt = { id: "bluetooth:AirPods", kind: "bluetooth" as const, name: "AirPods" };
  assert.equal(routeAnnouncement(sp, sp), null);
  assert.match(String(routeAnnouncement(sp, bt)), /AirPods/);
});
test("native payloads: new (kind/name) and legacy (speaker/headset/port) shapes", () => {
  assert.deepEqual(routeFromNative({ kind: "bluetooth", name: "AirPods" }), { id: "bluetooth:AirPods", kind: "bluetooth", name: "AirPods" });
  assert.equal(routeFromNative({ port: "Receiver" })?.kind, "earpiece");
  assert.equal(routeFromNative({ speaker: true })?.kind, "speaker");
  assert.ok(isHeadsetKind(routeFromNative({ headset: true, speaker: false })!.kind));
});
test("defaults: video → speaker, voice → earpiece, a headset always wins", () => {
  const sp = { id: "speaker", kind: "speaker" as const, name: "" };
  const ep = { id: "earpiece", kind: "earpiece" as const, name: "" };
  const bt = { id: "bluetooth:AirPods", kind: "bluetooth" as const, name: "AirPods" };
  assert.equal(defaultRoute([sp, ep], true)?.kind, "speaker");
  assert.equal(defaultRoute([sp, ep], false)?.kind, "earpiece");
  assert.equal(defaultRoute([sp, ep, bt], true)?.kind, "bluetooth");
  assert.equal(defaultRoute([sp, ep, bt], false)?.kind, "bluetooth");
  assert.equal(sortRoutes([bt, sp, ep]).length, 3);
});
test("web outputs: default/communications entries collapse; current = system default's device", () => {
  const { routes, current } = routesFromWebOutputs([
    { deviceId: "default", label: "Default - AirPods Pro (Bluetooth)" },
    { deviceId: "communications", label: "Communications - AirPods Pro (Bluetooth)" },
    { deviceId: "abc", label: "AirPods Pro (Bluetooth)" },
    { deviceId: "def", label: "MacBook Pro Speakers (Built-in)" },
  ]);
  assert.equal(routes.length, 2);
  assert.equal(current?.kind, "bluetooth");
  assert.equal(routesFromWebOutputs([]).routes.length, 0);
});
