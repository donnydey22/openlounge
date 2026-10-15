// ANDROID ONLY (Open Lounge Android WebView wrapper). The WebView's getUserMedia raises onPermissionRequest in
// MainActivity, which asks for RECORD_AUDIO / CAMERA at runtime. The bridge can report the OS state and open the
// app's settings page; a permanently denied permission ("don't ask again") can only be fixed there.
import type { OpenLoungeNativeBridge } from "../../native";
import { browserProbe, type CallReadiness, type PermState, type Probe, type ReadyInput } from "./types";

type AndroidBridge = OpenLoungeNativeBridge & { micPermission?(): string; cameraPermission?(): string };
const norm = (s: string | undefined): PermState => (s === "granted" || s === "denied" || s === "prompt" ? s : "unknown");

export async function ensureCallReadyAndroid(input: ReadyInput, bridge: AndroidBridge | null, probe: Probe = browserProbe): Promise<CallReadiness> {
  const mic = bridge?.micPermission ? norm(bridge.micPermission()) : await probe.query("microphone");
  const cam = !input.video ? "n/a" : bridge?.cameraPermission ? norm(bridge.cameraPermission()) : await probe.query("camera");
  const canOpenSettings = typeof bridge?.openAppSettings === "function";
  if (mic === "denied")
    return { platform: "android", ok: false, mic, cam, canOpenSettings, hint: "Open Lounge needs the microphone for calls. Settings ▸ Apps ▸ Open Lounge ▸ Permissions ▸ Microphone ▸ Allow." };
  return { platform: "android", ok: true, mic, cam, canOpenSettings, hint: cam === "denied" ? "Camera is off for Open Lounge: Settings ▸ Apps ▸ Open Lounge ▸ Permissions ▸ Camera." : undefined };
}
