/**
 * ICE config for every LiveKit connection (rooms + 1:1 calls).
 *
 * Production LiveKit runs on Railway with force_tcp (Railway routes no inbound UDP): media rides ICE/TCP straight to the
 * SFU's public TCP proxy, and the SFU learns each client's address from the TCP connection itself (peer-reflexive).
 * Clients therefore need no STUN/TURN servers at all.
 *
 * An explicit (empty) iceServers list matters: when the option is absent, livekit-client uses the server's list, and
 * LiveKit's built-in default STUN list includes a vendor we never use. Passing [] keeps every client off third-party
 * STUN hosts (no client IPs leaked to them, no wasted gathering). If a self-hosted TURN is ever enabled, put its
 * per-call credentials here instead (see /workspace/calls/turn-bench/RESULTS.md).
 */
export const LIVEKIT_RTC_CONFIG: RTCConfiguration = {
  iceTransportPolicy: "all",
  iceServers: [],
};
