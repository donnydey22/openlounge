// iOS ONLY (Open Lounge Expo/WKWebView wrapper). WKWebView getUserMedia uses the app's NSMicrophoneUsageDescription
// / NSCameraUsageDescription; once denied, iOS never re-prompts, so the only fix is the app's page in Settings.
// Navigator.permissions is unreliable in WKWebView (often "prompt" even when granted), so the bridge wins when present.
import type { OpenLoungeNativeBridge } from "../../native";
import { browserProbe, type CallReadiness, type PermState, type Probe, type ReadyInput } from "./types";

type IosBridge = OpenLoungeNativeBridge & { micPermission?(): string; cameraPermission?(): string };
const norm = (s: string | undefined): PermState => (s === "granted" || s === "denied" || s === "prompt" ? s : s === "undetermined" ? "prompt" : "unknown");

export async function ensureCallReadyIos(input: ReadyInput, bridge: IosBridge | null, probe: Probe = browserProbe): Promise<CallReadiness> {
  const mic = bridge?.micPermission ? norm(bridge.micPermission()) : await probe.query("microphone");
  const cam = !input.video ? "n/a" : bridge?.cameraPermission ? norm(bridge.cameraPermission()) : await probe.query("camera");
  const canOpenSettings = typeof bridge?.openAppSettings === "function";
  if (mic === "denied")
    return { platform: "ios", ok: false, mic, cam, canOpenSettings, hint: "Open Lounge needs the microphone for calls. Settings ▸ Open Lounge ▸ Microphone ▸ On." };
  return { platform: "ios", ok: true, mic, cam, canOpenSettings, hint: cam === "denied" ? "Camera is off for Open Lounge: Settings ▸ Open Lounge ▸ Camera." : undefined };
}
