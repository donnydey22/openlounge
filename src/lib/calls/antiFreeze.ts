// FX-079 anti-freeze (Donny, Oct 24 2026 8:13 PM MST: "the video feed should do its best not to freeze ever").
// Calls 30dc469c (ladder held video at 60 kbps / 8 fps) and bbbe198f (peer network drop).
//  - sender: under pressure drop RESOLUTION, keep motion (degradationPreference maintain-framerate) with a frame-rate
//    floor, so the picture gets softer instead of freezing;
//  - receiver: a frozen-frame watchdog. No new decoded frame for ~1.5 s → ask the sender for a keyframe (PLI via the
//    SFU); still frozen at ~4 s → re-resume the consumer; still frozen at ~8 s → re-sync consumers. Repeats every 8 s.
export const ANTI_FREEZE = {
  minFps: 15,
  degradationPreference: "maintain-framerate" as const,
  keyframeAfterMs: 1_500,
  resumeAfterMs: 4_000,
  resyncAfterMs: 8_000,
  sampleMs: 500,
} as const;

export type FreezeAction = "keyframe" | "resume" | "resync";

/** Pure state machine: feed (time, framesDecoded); returns the recovery step to take now, if any. */
export class FrozenFrameWatchdog {
  private lastFrames = -1;
  private lastFrameAt = 0;
  private done = new Set<FreezeAction>();
  stalls = 0;
  push(at: number, framesDecoded: number): FreezeAction | null {
    if (this.lastFrames < 0 || framesDecoded > this.lastFrames) {
      this.lastFrames = framesDecoded;
      this.lastFrameAt = at;
      this.done.clear();
      return null;
    }
    const gap = at - this.lastFrameAt;
    if (gap >= ANTI_FREEZE.resyncAfterMs && !this.done.has("resync")) {
      this.done.add("resync");
      return "resync";
    }
    if (gap >= ANTI_FREEZE.resumeAfterMs && !this.done.has("resume")) {
      this.done.add("resume");
      return "resume";
    }
    if (gap >= ANTI_FREEZE.keyframeAfterMs && !this.done.has("keyframe")) {
      this.done.add("keyframe");
      this.stalls++;
      return "keyframe";
    }
    if (this.done.has("resync") && gap >= ANTI_FREEZE.resyncAfterMs * 2) {
      // still frozen long after a full cycle: start again (keyframe → resume → resync)
      this.lastFrameAt = at;
      this.done.clear();
    }
    return null;
  }
}

/** The ladder rung's video encoding with the anti-freeze floor applied (never below minFps). */
export const antiFreezeFps = (fps: number) => Math.max(fps, ANTI_FREEZE.minFps);
