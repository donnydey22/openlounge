// Native-app-only network adaptation for calls (Donny, Oct 15 2026).
//
// Scope gate (airtight, single source): ONLY inside the Open Lounge native wrappers (Android WebView / iOS Expo
// WKWebView), detected by the bridge both wrappers inject — window.OpenLoungeNative.getPlatform() → "android" | "ios".
// No UA sniffing. Desktop web and mobile browsers keep the existing behaviour (UDP-first, QualityGuard → TCP).
//
// Inside the apps, one coordinated ladder replaces the "8 s bad → TCP" jump:
//   L0 full  →  L1  →  L2  →  L3 floor  →  TCP (LiveKit)
// Audio (Opus maxBitrate) and video (resolution scale + framerate + bitrate) step together. Down after
// DOWN_AFTER consecutive bad samples, up after UP_AFTER consecutive good samples (hysteresis, anti-flap). Only when the
// floor is still bad for TCP_AFTER samples does it ask for the TCP fallback. Return-to-UDP stays with udpRecovery.ts.
import { nativePlatform } from "@/lib/native";
import type { QualityVerdict } from "./qualityGuard";

export type NativePlatform = "android" | "ios";

/** The one gate. Every native-only call behaviour checks this and nothing else. */
export function nativeAdaptiveEnabled(platform: NativePlatform | null = nativePlatform()): boolean {
  return platform === "android" || platform === "ios";
}

export interface LadderStep {
  /** Opus target (bps) for the mic producer */
  audioBps: number;
  /** video: divide resolution by this, cap fps and bitrate (applied only if a camera producer exists) */
  videoScale: number;
  videoFps: number;
  videoBps: number;
}

export const LADDER: readonly LadderStep[] = [
  { audioBps: 48_000, videoScale: 1, videoFps: 30, videoBps: 1_200_000 },
  { audioBps: 32_000, videoScale: 2, videoFps: 24, videoBps: 400_000 },
  { audioBps: 24_000, videoScale: 4, videoFps: 15, videoBps: 150_000 },
  { audioBps: 16_000, videoScale: 4, videoFps: 8, videoBps: 60_000 },
] as const;

export const ADAPT = {
  sampleMs: 2_000,
  /** bad samples in a row before stepping down (4 s) */
  downAfter: 2,
  /** good samples in a row before stepping up (10 s) */
  upAfter: 5,
  /** bad samples in a row AT THE FLOOR before TCP (6 s) */
  tcpAfter: 3,
  /** "bad" for the ladder (earlier than QualityGuard's TCP limits so bitrate drops first) */
  lossPercent: 5,
  rttMs: 450,
  /** "severe" = what the floor cannot carry: Opus floor + RTP/UDP overhead */
  severeLossPercent: 10,
  floorKbps: 24,
  /** "good" for stepping up needs clear headroom */
  goodLossPercent: 2,
  goodRttMs: 250,
} as const;

export type AdaptAction = { type: "none" } | { type: "step"; level: number; step: LadderStep; dir: "down" | "up" } | { type: "tcp"; reasons: string[] };

/** Pure state machine; feed one QualityVerdict per sample. */
export class NetLadder {
  level = 0;
  private bad = 0;
  private good = 0;
  private floorBad = 0;

  push(v: Pick<QualityVerdict, "lossPercent" | "rttMs" | "outKbps" | "reasons">): AdaptAction {
    const loss = v.lossPercent ?? 0;
    const rtt = v.rttMs ?? 0;
    const out = v.outKbps;
    const needKbps = LADDER[this.level].audioBps / 1000 + 8; // + RTP/UDP/IP overhead
    const severe = loss > ADAPT.severeLossPercent || (out !== null && out > 0 && out < ADAPT.floorKbps) || v.reasons.includes("no-audio");
    const bad = severe || loss > ADAPT.lossPercent || rtt > ADAPT.rttMs || (out !== null && out > 0 && out < needKbps);
    const good = !bad && loss <= ADAPT.goodLossPercent && rtt <= ADAPT.goodRttMs && (out === null || out <= 0 || out >= needKbps * 1.5);
    this.bad = bad ? this.bad + 1 : 0;
    this.good = good ? this.good + 1 : 0;
    const floor = this.level === LADDER.length - 1;
    this.floorBad = floor && severe ? this.floorBad + 1 : 0;
    if (floor && this.floorBad >= ADAPT.tcpAfter) {
      this.floorBad = 0;
      return { type: "tcp", reasons: v.reasons.length ? v.reasons : ["floor"] };
    }
    if (!floor && this.bad >= ADAPT.downAfter) {
      this.bad = 0;
      // a severe sample skips a rung so a collapsing link reaches the floor within ~4–8 s
      this.level = Math.min(LADDER.length - 1, this.level + (severe ? 2 : 1));
      return { type: "step", level: this.level, step: LADDER[this.level], dir: "down" };
    }
    if (this.level > 0 && this.good >= ADAPT.upAfter) {
      this.good = 0;
      this.level -= 1;
      return { type: "step", level: this.level, step: LADDER[this.level], dir: "up" };
    }
    return { type: "none" };
  }

  reset(level = 0) {
    this.level = level;
    this.bad = this.good = this.floorBad = 0;
  }
}
