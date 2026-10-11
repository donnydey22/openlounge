// Call video quality policy (pure; no livekit-client value imports so it unit-tests in Node).
//  - Codec: H.264 on phones (iOS WKWebView / Safari, Android WebView / Chrome) where the browser can actually encode it
//    (RTCRtpSender.getCapabilities), VP8 as the backup codec; VP8 everywhere else. Never picks H.264 blindly.
//  - Simulcast: per-layer bitrate + frame-rate caps (h180 ~15 fps / 150 kbps, h360 ~24 fps / 400 kbps, top ~1.2 Mbps).
//  - Audio first: full-band Opus voice with DTX + RED, sender priority / networkPriority "high"; video layers stay "low".
import type { LocalVideoTrack, Room, TrackPublishOptions } from "livekit-client";

export type CallVideoCodec = "h264" | "vp8";

export interface CodecEnv {
  ua: string;
  maxTouchPoints?: number;
  /** "ios" / "android" when the native wrapper says so */
  nativePlatform?: "ios" | "android" | null;
  /** RTCRtpSender.getCapabilities("video") result (null = API missing) */
  caps?: { codecs: { mimeType: string; sdpFmtpLine?: string }[] } | null;
  /** debug override from localStorage (openlounge:vcodec) */
  override?: string | null;
}

export interface CodecChoice {
  codec: CallVideoCodec;
  backup: CallVideoCodec | false;
  phone: boolean;
  h264: boolean;
  reason: string;
}

/** Phone / tablet class device: native wrappers, iOS/iPadOS (incl. desktop-UA iPad), Android, generic "Mobi". */
export function isPhoneLike(env: Pick<CodecEnv, "ua" | "maxTouchPoints" | "nativePlatform">): boolean {
  if (env.nativePlatform === "ios" || env.nativePlatform === "android") return true;
  const ua = env.ua || "";
  if (/OpenLounge(iOS|Android)/.test(ua)) return true;
  if (/iPhone|iPad|iPod|Android|Mobi/i.test(ua)) return true;
  // iPadOS 13+ reports a Mac desktop UA; touch points give it away
  return /Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1;
}

export function isAndroid(env: Pick<CodecEnv, "ua" | "nativePlatform">): boolean {
  return env.nativePlatform === "android" || /OpenLoungeAndroid|Android/i.test(env.ua || "");
}

/** H.264 the SFU / other browsers can take: packetization-mode=1 (or any H.264 entry when fmtp lines are absent). */
export function canSendH264(caps: CodecEnv["caps"]): boolean {
  const list = caps?.codecs ?? [];
  const h264 = list.filter((c) => /^video\/h264$/i.test(c.mimeType));
  if (!h264.length) return false;
  if (h264.every((c) => !c.sdpFmtpLine)) return true;
  return h264.some((c) => /packetization-mode=1/.test(c.sdpFmtpLine ?? ""));
}

export function chooseVideoCodec(env: CodecEnv): CodecChoice {
  const phone = isPhoneLike(env);
  const h264 = canSendH264(env.caps);
  const o = (env.override || "").toLowerCase();
  if (o === "vp8") return { codec: "vp8", backup: false, phone, h264, reason: "override" };
  if (o === "h264" && h264) return { codec: "h264", backup: "vp8", phone, h264, reason: "override" };
  // Android: H.264 with no VP8 backup, so each camera track is one negotiation (a backup-codec renegotiation timing out
  // dropped audio on call c31351b4). Every subscriber we ship (Android/iOS WebView, Chrome, Safari, Firefox) decodes
  // H.264; if the H.264 publish itself fails, publishCamera still falls back to VP8.
  if (phone && h264 && isAndroid(env)) return { codec: "h264", backup: false, phone, h264, reason: "android-h264-single" };
  if (phone && h264) return { codec: "h264", backup: "vp8", phone, h264, reason: "phone-h264" };
  return { codec: "vp8", backup: false, phone, h264, reason: phone ? "phone-no-h264" : "desktop" };
}

/** Read the live browser environment (safe on SSR / old browsers: falls back to VP8). */
export function browserCodecEnv(nativePlatform?: "ios" | "android" | null): CodecEnv {
  if (typeof navigator === "undefined") return { ua: "", caps: null };
  let caps: CodecEnv["caps"] = null;
  try {
    const S = (globalThis as { RTCRtpSender?: { getCapabilities?: (k: string) => CodecEnv["caps"] } }).RTCRtpSender;
    caps = S?.getCapabilities?.("video") ?? null;
  } catch {
    caps = null;
  }
  let override: string | null = null;
  try {
    override = localStorage.getItem("openlounge:vcodec");
  } catch {}
  return { ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, nativePlatform, caps, override };
}

let cached: CodecChoice | null = null;
export function currentCodecChoice(nativePlatform?: "ios" | "android" | null): CodecChoice {
  return (cached ??= chooseVideoCodec(browserCodecEnv(nativePlatform)));
}
/** test hook */
export function resetCodecChoice() {
  cached = null;
}

// ---------- encodings ----------
export interface LayerCap {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
}
/** 16:9 landscape dims; LiveKit scales by the short side, so portrait phone capture gets the same caps. */
export const VIDEO_LAYERS = {
  low: { width: 320, height: 180, maxBitrate: 150_000, maxFramerate: 15 },
  mid: { width: 640, height: 360, maxBitrate: 400_000, maxFramerate: 24 },
  top: { width: 1280, height: 720, maxBitrate: 1_200_000, maxFramerate: 30 },
} as const satisfies Record<string, LayerCap>;

/** 48 kbps leaves Opus enough bandwidth for a fuller, more natural voice while DTX, RED and priority protect calls under loss. */
export const AUDIO_SPEECH = { maxBitrate: 48_000, priority: "high" as RTCPriorityType };

type LKLike = {
  VideoPreset: new (width: number, height: number, maxBitrate: number, maxFramerate?: number, priority?: RTCPriorityType) => {
    encoding: { maxBitrate: number; maxFramerate?: number; priority?: RTCPriorityType };
    width: number;
    height: number;
  };
};

// ---------- network tier (low-bandwidth caps) ----------
export type NetworkTier = "low" | "normal";
export interface NetInfoLike {
  effectiveType?: string;
  saveData?: boolean;
  /** Mbps estimate */
  downlink?: number;
}
/**
 * "low" on Data Saver, 2g/3g (incl. slow-2g) or a measured downlink under 1.5 Mbps; "normal" otherwise or when the
 * Network Information API is missing (Safari/Firefox: LiveKit's congestion control + dynacast still adapt live).
 */
export function networkTier(info?: NetInfoLike | null, override?: string | null): NetworkTier {
  const o = (override || "").toLowerCase();
  if (o === "low" || o === "normal") return o;
  if (!info) return "normal";
  if (info.saveData) return "low";
  if (info.effectiveType && /(^|-)2g$|^3g$/.test(info.effectiveType)) return "low";
  if (typeof info.downlink === "number" && info.downlink > 0 && info.downlink < 1.5) return "low";
  return "normal";
}
export function browserNetworkTier(): NetworkTier {
  if (typeof navigator === "undefined") return "normal";
  let override: string | null = null;
  try {
    override = localStorage.getItem("openlounge:vnet");
  } catch {}
  return networkTier((navigator as Navigator & { connection?: NetInfoLike }).connection ?? null, override);
}
/** Camera capture size per tier: 360p on low networks (smaller encode, less CPU/heat), 720p otherwise. */
export function captureResolution(tier: NetworkTier): { width: number; height: number; frameRate: number } {
  return tier === "low" ? { width: 640, height: 360, frameRate: 24 } : { width: 1280, height: 720, frameRate: 30 };
}

/**
 * Camera publish options for the chosen codec (simulcast with capped layers, VP8 backup when H.264 is primary).
 * Low tier: top layer capped at 360p / 400 kbps / 24 fps with a single 180p layer under it.
 */
export function cameraPublishOptions(LK: LKLike, choice: Pick<CodecChoice, "codec" | "backup">, tier: NetworkTier = "normal"): Partial<TrackPublishOptions> {
  const { low, mid, top } = VIDEO_LAYERS;
  if (tier === "low")
    return {
      simulcast: true,
      videoCodec: choice.codec,
      backupCodec: choice.backup ? { codec: choice.backup } : false,
      videoEncoding: { maxBitrate: mid.maxBitrate, maxFramerate: mid.maxFramerate, priority: "low" },
      videoSimulcastLayers: [new LK.VideoPreset(low.width, low.height, low.maxBitrate, low.maxFramerate, "low")] as TrackPublishOptions["videoSimulcastLayers"],
    };
  return {
    simulcast: true,
    videoCodec: choice.codec,
    backupCodec: choice.backup ? { codec: choice.backup } : false,
    videoEncoding: { maxBitrate: top.maxBitrate, maxFramerate: top.maxFramerate, priority: "low" },
    videoSimulcastLayers: [
      new LK.VideoPreset(low.width, low.height, low.maxBitrate, low.maxFramerate, "low"),
      new LK.VideoPreset(mid.width, mid.height, mid.maxBitrate, mid.maxFramerate, "low"),
    ] as TrackPublishOptions["videoSimulcastLayers"],
  };
}

/** Microphone publish options: full-band Opus voice, DTX (silence ~0 kbps), RED (loss resilience), high sender + network priority. */
export function micPublishOptions(): Partial<TrackPublishOptions> {
  return { dtx: true, red: true, audioPreset: { ...AUDIO_SPEECH } };
}

/** Room publishDefaults built from the policy. */
export function publishDefaults(LK: LKLike, choice: Pick<CodecChoice, "codec" | "backup">, tier: NetworkTier = "normal"): Partial<TrackPublishOptions> {
  return { ...micPublishOptions(), ...cameraPublishOptions(LK, choice, tier) };
}

/**
 * Publish the camera with the preferred codec; if the publish throws (e.g. an H.264 encoder that the device
 * advertises but can't open), retry once with plain VP8 so video never fails because of the codec choice.
 */
export async function publishCamera(
  LK: LKLike & { Track: { Source: { Camera: TrackPublishOptions["source"] } } },
  room: Room,
  cam: LocalVideoTrack,
  choice: Pick<CodecChoice, "codec" | "backup">,
  tier: NetworkTier = "normal",
) {
  const base = { source: LK.Track.Source.Camera };
  try {
    return await room.localParticipant.publishTrack(cam, { ...cameraPublishOptions(LK, choice, tier), ...base });
  } catch (e) {
    if (choice.codec === "vp8") throw e;
    if (cached) cached = { ...cached, codec: "vp8", backup: false, reason: "h264-publish-failed" };
    return await room.localParticipant.publishTrack(cam, { ...cameraPublishOptions(LK, { codec: "vp8", backup: false }, tier), ...base });
  }
}
