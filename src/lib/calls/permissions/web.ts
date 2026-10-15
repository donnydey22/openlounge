// WEB ONLY (Chrome/Edge/Firefox/Safari tabs). No native bridge here; never shares a path with iOS/Android.
import { browserProbe, type CallReadiness, type Probe, type ReadyInput } from "./types";

export function webHint(ua: string, what: "microphone" | "camera") {
  if (/Firefox\//.test(ua)) return `Allow the ${what}: click the ${what} icon in the address bar, then Allow.`;
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return `Allow the ${what}: Safari ▸ Settings for This Website ▸ ${what === "microphone" ? "Microphone" : "Camera"} ▸ Allow.`;
  return `Allow the ${what}: click the lock icon in the address bar ▸ Site settings ▸ ${what === "microphone" ? "Microphone" : "Camera"} ▸ Allow.`;
}

export async function ensureCallReadyWeb(input: ReadyInput, probe: Probe = browserProbe, ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): Promise<CallReadiness> {
  if (typeof window !== "undefined" && !window.isSecureContext)
    return { platform: "web", ok: false, mic: "unknown", cam: input.video ? "unknown" : "n/a", hint: "Calls need a secure (https) page.", canOpenSettings: false };
  const mic = await probe.query("microphone");
  const cam = input.video ? await probe.query("camera") : "n/a";
  // Only a KNOWN denial blocks: "prompt"/"unknown" (Firefox, old Safari) go on to getUserMedia, which prompts at Accept.
  if (mic === "denied") return { platform: "web", ok: false, mic, cam, hint: webHint(ua, "microphone"), canOpenSettings: false };
  // A denied camera never blocks the call: it continues as audio.
  return { platform: "web", ok: true, mic, cam, hint: cam === "denied" ? webHint(ua, "camera") : undefined, canOpenSettings: false };
}
