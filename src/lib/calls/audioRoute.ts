/**
 * Call audio output routes: one model for iOS (AVAudioSession ports), Android (AudioDeviceInfo types) and the web
 * (audiooutput labels), so the call screen can show WHERE audio plays — Speaker, Phone (earpiece), Headphones, or the
 * Bluetooth device by name (AirPods) — with a distinct icon each, like WhatsApp/FaceTime.
 * Pure functions only; the engine owns state and the native wrappers own the actual routing.
 */
export type AudioRouteKind = "speaker" | "earpiece" | "wired" | "bluetooth" | "usb" | "car" | "system";
export type AudioRoute = { id: string; kind: AudioRouteKind; name: string };
export type RouteIcon = "speaker" | "phone" | "headphones" | "bluetooth" | "car" | "system";

const KINDS: ReadonlySet<string> = new Set(["speaker", "earpiece", "wired", "bluetooth", "usb", "car", "system"]);
export const isRouteKind = (k: unknown): k is AudioRouteKind => typeof k === "string" && KINDS.has(k);
/** headset-class routes: plugged/paired devices that win over speaker/earpiece by default */
export const isHeadsetKind = (k: AudioRouteKind) => k === "wired" || k === "bluetooth" || k === "usb" || k === "car";

/** AVAudioSession.Port raw values (portType.rawValue) → kind */
export function kindFromIosPort(port: string): AudioRouteKind | null {
  switch (port) {
    case "Speaker": return "speaker";
    case "Receiver": return "earpiece";
    case "Headphones": case "HeadsetMicrophone": case "LineOut": return "wired";
    case "BluetoothA2DPOutput": case "BluetoothHFP": case "BluetoothLE": return "bluetooth";
    case "USBAudio": return "usb";
    case "CarAudio": return "car";
    case "AirPlay": case "HDMI": return "system";
    default: return null;
  }
}

/** android.media.AudioDeviceInfo TYPE_* → kind (the wrapper sends numbers or our kind strings) */
export function kindFromAndroidType(t: number): AudioRouteKind | null {
  switch (t) {
    case 1: return "earpiece"; // BUILTIN_EARPIECE
    case 2: return "speaker"; // BUILTIN_SPEAKER
    case 3: case 4: case 5: case 6: return "wired"; // WIRED_HEADSET, WIRED_HEADPHONES, LINE_ANALOG, LINE_DIGITAL
    case 7: case 8: case 23: case 26: case 27: case 30: return "bluetooth"; // SCO, A2DP, HEARING_AID, BLE_HEADSET, BLE_SPEAKER, BLE_BROADCAST
    case 11: case 12: case 22: return "usb"; // USB_DEVICE, USB_ACCESSORY, USB_HEADSET
    case 9: case 10: return "system"; // HDMI
    default: return null;
  }
}

/** Web audiooutput label → kind. Browsers give no type, only a label ("Default - AirPods Pro (Bluetooth)"). */
export function kindFromWebLabel(label: string): AudioRouteKind {
  const l = label.toLowerCase();
  if (/airpods|bluetooth|buds|beats|bose|jabra|wh-1000|wf-1000|hands-free|headset \(bt\)|\bbt\b/.test(l)) return "bluetooth";
  if (/usb/.test(l)) return "usb";
  if (/headphone|headset|earphone|earpod|line out|3\.5|jack/.test(l)) return "wired";
  if (/earpiece|receiver/.test(l)) return "earpiece";
  if (/speaker|built-in output|internal/.test(l)) return "speaker";
  return "system";
}

/** strip browser decorations: "Default - AirPods Pro (Bluetooth)" → "AirPods Pro" */
export function cleanDeviceName(label: string): string {
  return label.replace(/^(default|communications)\s*-\s*/i, "").replace(/\s*\((bluetooth|built-in|[0-9a-f]{4}:[0-9a-f]{4})\)\s*$/i, "").trim();
}

const GENERIC: Record<AudioRouteKind, string> = { speaker: "Speaker", earpiece: "Phone", wired: "Headphones", bluetooth: "Bluetooth", usb: "USB audio", car: "Car", system: "Device audio" };
/** Button / sheet label: Bluetooth and car show the device name (AirPods), the rest a clear generic word. */
export function routeLabel(r: Pick<AudioRoute, "kind" | "name"> | null | undefined): string {
  if (!r) return "Audio";
  const n = (r.name || "").trim();
  if ((r.kind === "bluetooth" || r.kind === "car" || r.kind === "usb") && n && !/^(bluetooth|headset|speaker|usb audio)$/i.test(n)) return n.length > 22 ? n.slice(0, 21) + "…" : n;
  return GENERIC[r.kind];
}
export function routeIcon(kind: AudioRouteKind | undefined): RouteIcon {
  switch (kind) {
    case "speaker": return "speaker";
    case "earpiece": return "phone";
    case "wired": case "usb": return "headphones";
    case "bluetooth": return "bluetooth";
    case "car": return "car";
    default: return "system";
  }
}
/** spoken/visible announcement when the route changes on its own (device connected / removed) */
export function routeAnnouncement(prev: AudioRoute | null, next: AudioRoute): string | null {
  if (prev && prev.kind === next.kind && prev.name === next.name) return null;
  const label = routeLabel(next);
  return next.kind === "earpiece" ? "Audio on phone" : next.kind === "speaker" ? "Audio on speaker" : `Audio on ${label}`;
}

/** Default route: video → speaker, voice → earpiece, unless a headset-class device is available (it wins). */
export function defaultRoute(routes: AudioRoute[], video: boolean): AudioRoute | null {
  const pref: AudioRouteKind[] = ["bluetooth", "wired", "usb", "car", video ? "speaker" : "earpiece", video ? "earpiece" : "speaker", "system"];
  for (const k of pref) { const r = routes.find((x) => x.kind === k); if (r) return r; }
  return null;
}

/** Sort for the picker sheet: built-ins first (Phone, Speaker), then devices. */
const ORDER: Record<AudioRouteKind, number> = { earpiece: 0, speaker: 1, wired: 2, usb: 3, bluetooth: 4, car: 5, system: 6 };
export function sortRoutes(routes: AudioRoute[]): AudioRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name));
}

/** Parse a native `openlounge:native-audio-route` detail (iOS build ≤61 sends only port/name/headset/speaker). */
export type NativeRouteDetail = { kind?: unknown; port?: unknown; name?: unknown; id?: unknown; headset?: unknown; speaker?: unknown; type?: unknown; routes?: unknown; reason?: unknown; user?: unknown };
export function routeFromNative(d: NativeRouteDetail): AudioRoute | null {
  const name = typeof d.name === "string" ? d.name.slice(0, 64) : "";
  let kind: AudioRouteKind | null = isRouteKind(d.kind) ? d.kind : null;
  if (!kind && typeof d.port === "string") kind = kindFromIosPort(d.port);
  if (!kind && typeof d.type === "number") kind = kindFromAndroidType(d.type);
  if (!kind && typeof d.speaker === "boolean") kind = d.headset === true ? "wired" : d.speaker ? "speaker" : "earpiece";
  if (!kind) return null;
  const id = typeof d.id === "string" && d.id ? d.id.slice(0, 96) : kind === "speaker" || kind === "earpiece" ? kind : `${kind}:${name}`;
  return { id, kind, name };
}
export function routesFromNative(list: unknown): AudioRoute[] {
  if (!Array.isArray(list)) return [];
  return sortRoutes(list.slice(0, 12).map((x) => (x && typeof x === "object" ? routeFromNative(x as NativeRouteDetail) : null)).filter((r): r is AudioRoute => !!r));
}

/** Web: audiooutput devices → routes. "default"/"communications" are aliases of real devices and are collapsed. */
export function routesFromWebOutputs(outs: { deviceId: string; label: string }[]): { routes: AudioRoute[]; current: AudioRoute | null } {
  const real = outs.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
  const routes = sortRoutes(real.map((d) => ({ id: d.deviceId, kind: kindFromWebLabel(d.label), name: cleanDeviceName(d.label) || "Audio device" })));
  const def = outs.find((d) => d.deviceId === "default");
  const defName = def ? cleanDeviceName(def.label) : "";
  const current = (defName && routes.find((r) => r.name === defName)) || (def ? { id: "default", kind: kindFromWebLabel(def.label), name: defName || "Device audio" } : routes[0] ?? null);
  return { routes, current };
}
