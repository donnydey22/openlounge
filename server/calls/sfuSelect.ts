/** Call rollout gates. The SFU/mediasoup and LiveKit call lanes were removed (RingRTC hard cut);
 * calls are p2p WebRTC only, signalled over sealed rc:* (see server/calls/rcRelay.ts). */
/** CALL_IOS_NATIVE_VIDEO=on gates app-owned iPhone video media (OLRtcVideo on the OLRtcCall PC). */
export function iosNativeVideoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CALL_IOS_NATIVE_VIDEO === "on";
}
