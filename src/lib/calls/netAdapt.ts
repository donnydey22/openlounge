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

/**
 * Thresholds (Donny, Oct 17 — bandwidth-aware, WhatsApp-style, single encoding, no simulcast). All platforms.
 *  - poll getStats every 1 s (availableOutgoingBitrate, loss, RTT)
 *  - step DOWN after 2 bad samples (2 s): loss > 5 % or RTT > 450 ms or bandwidth below the rung's audio need
 *  - SEVERE (loss > 15 %, bandwidth < 24 kbps, or no outgoing audio) jumps straight to the floor rung
 *  - step UP one rung after 8 good samples in a row (8 s steady: loss <= 2 %, RTT <= 250 ms, 1.5x headroom)
 *  - RECONNECT (main SFU only: ICE restart → rebuild; ICE-TCP 40443 and TURNS 443 are offered in every transport)
 *    when the floor is still severe for 3 more samples: ~5 s of > 15 % loss in total
 *  - after a reconnect the ladder starts at rung 1 (conservative) and climbs only on measured headroom
 *  - video bitrate also tracks the live estimate: min(rung cap, 0.85 x availableOutgoingBitrate - audio), never below 60 kbps
 *  - audio is never starved: the mic encoding is priority/networkPriority "high"; Opus floor is 16 kbps, never paused
 */
export const ADAPT = {
  sampleMs: 1_000,
  /** bad samples in a row before stepping down (2 s) */
  downAfter: 2,
  /** good samples in a row before stepping up (8 s) */
  upAfter: 8,
  /** severe samples in a row AT THE FLOOR before the SFU reconnect flow (3 s; ~5 s from the first severe sample) */
  tcpAfter: 3,
  /** rung used after a reconnect (conservative start, then climb on measured headroom) */
  reconnectLevel: 1,
  /** fraction of availableOutgoingBitrate video may use (after audio) */
  videoShareOfEstimate: 0.85,
  minVideoBps: 60_000,
  /** "bad" for the ladder (earlier than QualityGuard's TCP limits so bitrate drops first) */
  lossPercent: 5,
  rttMs: 450,
  /** "severe" = what the floor cannot carry: Opus floor + RTP/UDP overhead */
  severeLossPercent: 15,
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
      // a severe sample goes straight to the floor (audio-first) so a collapsing link is protected within 2 s
      this.level = severe ? LADDER.length - 1 : Math.min(LADDER.length - 1, this.level + 1);
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

/** Video bitrate for the current rung, tracking the live bandwidth estimate (kbps from availableOutgoingBitrate). */
export function videoBpsFor(step: LadderStep, outKbps: number | null): number {
  if (outKbps === null || !(outKbps > 0)) return step.videoBps;
  const share = Math.floor(outKbps * 1000 * ADAPT.videoShareOfEstimate) - step.audioBps;
  return Math.max(ADAPT.minVideoBps, Math.min(step.videoBps, share));
}
