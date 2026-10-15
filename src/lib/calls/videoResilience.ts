// Receive-side video sturdiness wrapper (Android baseline safe).
//
// It NEVER touches an RTCRtpSender, encodings, codec choice, resolution, bitrate or framerate: the Android video
// configuration from the Keiko call (tests/calls/androidVideoFrozen.test.ts) is frozen. Everything here acts on the
// RECEIVER side only:
//  - audit that loss recovery is negotiated: NACK, PLI, FIR (keyframe requests), RTX (retransmission), FEC if offered;
//  - adaptive receiver jitter buffer: when the remote picture stalls while packets still arrive, raise the receiver's
//    jitterBufferTarget so late/retransmitted (NACK/RTX) packets make it into a frame; drop back to the browser
//    default once the stream has been smooth again for a while;
//  - last-frame hold stays with frameHold.ts (canvas keeps the last frame during any gap).

export const VIDEO_RESILIENCE = {
  /** browser default jitter buffer (null) while smooth */
  baseJitterTargetMs: null as number | null,
  /** target while recovering from a stall (enough for one NACK/RTX round trip on a mobile link) */
  stallJitterTargetMs: 150,
  /** a stall = no new decoded frame for this long while RTP packets are still arriving */
  stallMs: 1_000,
  /** smooth this long before returning to the default buffer (hysteresis) */
  recoverMs: 10_000,
  sampleMs: 1_000,
} as const;

export interface VideoResilienceAudit {
  nack: boolean;
  pli: boolean;
  fir: boolean;
  rtx: boolean;
  fec: boolean;
  transportCc: boolean;
}

/** Read the recovery mechanisms negotiated for the first video m-section of an SDP. */
export function auditVideoSdp(sdp: string): VideoResilienceAudit {
  const section = sdp.split(/\r?\nm=/).find((s) => s.startsWith("video") || s.startsWith("m=video")) ?? "";
  return {
    nack: /a=rtcp-fb:\S+ nack\r?$/m.test(section),
    pli: /a=rtcp-fb:\S+ nack pli/m.test(section),
    fir: /a=rtcp-fb:\S+ ccm fir/m.test(section),
    rtx: /a=rtpmap:\d+ rtx\//m.test(section),
    fec: /a=rtpmap:\d+ (ulpfec|flexfec-03|red)\//m.test(section),
    transportCc: /a=rtcp-fb:\S+ transport-cc/m.test(section),
  };
}

/** Required for a sturdy stream; FEC is optional (mediasoup forwards it only when the sender negotiates it). */
export function missingResilience(a: VideoResilienceAudit): string[] {
  return (["nack", "pli", "fir", "rtx"] as const).filter((k) => !a[k]);
}

export interface InboundVideoSample {
  at: number;
  framesDecoded: number;
  packetsReceived: number;
  nackCount?: number;
  pliCount?: number;
  firCount?: number;
}

type JitterReceiver = { jitterBufferTarget?: number | null; getStats?: () => Promise<RTCStatsReport> };

/** Pure state machine: feed inbound-rtp samples, get the receiver jitter target to apply (or undefined = no change). */
export class VideoStallTracker {
  private lastFrames = -1;
  private lastFrameAt = 0;
  private lastPackets = -1;
  stalled = false;
  private smoothSince = 0;
  stalls = 0;

  push(s: InboundVideoSample): number | null | undefined {
    if (this.lastFrames < 0 || s.framesDecoded > this.lastFrames) this.lastFrameAt = s.at;
    const packetsFlowing = this.lastPackets >= 0 && s.packetsReceived > this.lastPackets;
    this.lastFrames = s.framesDecoded;
    this.lastPackets = s.packetsReceived;
    const frozen = s.at - this.lastFrameAt >= VIDEO_RESILIENCE.stallMs;
    if (frozen && packetsFlowing) {
      this.smoothSince = 0;
      if (!this.stalled) {
        this.stalled = true;
        this.stalls++;
        return VIDEO_RESILIENCE.stallJitterTargetMs;
      }
      return undefined;
    }
    if (this.stalled && !frozen) {
      this.smoothSince ||= s.at;
      if (s.at - this.smoothSince >= VIDEO_RESILIENCE.recoverMs) {
        this.stalled = false;
        this.smoothSince = 0;
        return VIDEO_RESILIENCE.baseJitterTargetMs;
      }
    }
    return undefined;
  }
}

/** Attach to a remote video RTCRtpReceiver. Returns a stop function. Receiver-only; no sender is ever touched. */
export function watchVideoResilience(receiver: JitterReceiver | null | undefined, log?: (ev: string, x?: Record<string, unknown>) => void): () => void {
  if (!receiver?.getStats) return () => {};
  const tracker = new VideoStallTracker();
  const timer = setInterval(() => {
    void receiver.getStats!().then((report) => {
      let s: InboundVideoSample | null = null;
      report.forEach((r: any) => {
        if (r.type === "inbound-rtp" && r.kind === "video") s = { at: Date.now(), framesDecoded: r.framesDecoded ?? 0, packetsReceived: r.packetsReceived ?? 0, nackCount: r.nackCount, pliCount: r.pliCount, firCount: r.firCount };
      });
      if (!s) return;
      const target = tracker.push(s);
      if (target === undefined || !("jitterBufferTarget" in receiver)) return;
      try {
        receiver.jitterBufferTarget = target;
      } catch { /* unsupported engine: frameHold still covers the gap */ }
      const x = s as InboundVideoSample;
      log?.(target ? "video-stall-buffer" : "video-stall-recovered", { target, nack: x.nackCount, pli: x.pliCount, fir: x.firCount });
    }).catch(() => {});
  }, VIDEO_RESILIENCE.sampleMs);
  return () => clearInterval(timer);
}
