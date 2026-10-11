import type { TurnIceServer } from "./types";

/**
 * ICE config for LiveKit connections. Railway's SFU remains force_tcp, so the explicit empty
 * list retains the established TCP-only path when a call has no self-hosted TURN credential.
 * Passing an explicit list also prevents livekit-client from adding an unapproved default STUN service.
 */
export function livekitRtcConfig(iceServers?: TurnIceServer[] | null): RTCConfiguration {
  return {
    iceTransportPolicy: "all",
    iceServers: iceServers?.length ? iceServers : [],
  };
}

/** Room audio has no per-call TURN credential and therefore stays on the established explicit-empty-ICE path. */
export const LIVEKIT_RTC_CONFIG = livekitRtcConfig();
