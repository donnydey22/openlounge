// OL-owned ICE configuration for 1:1 P2P calls (Signal-style: direct ICE first, OL TURN relay as an ICE candidate
// class, never a separate "ladder"). Credentials are TURN REST creds minted per call+user and short-lived.
import type { CallMedia, TurnIceServer } from "../../src/lib/types";
import { mintTurnIceServers, TURN_URLS } from "../turnCredentials";

/** Calls re-fetch config (call:get / rtc:iceConfig) well before this; 10 min matches the prior call TURN TTL. */
export const RTC_TURN_TTL_S = 600;

/** OL STUN on the same DO Pion host — no third-party STUN. */
export const RTC_STUN_URLS = ["stun:turn.openlounge.app:13478"] as const;

export interface RtcIceConfig {
  iceServers: Array<TurnIceServer | { urls: string[] }>;
  /** "all": host/srflx/relay — ICE picks direct before relay. Relay is never forced for local (audio) failures. */
  iceTransportPolicy: "all";
  expiresAt: number;
}

export function rtcIceConfig(callId: string, userId: string, opts: { secret?: string | null; now?: () => number } = {}): RtcIceConfig {
  const now = opts.now?.() ?? Date.now();
  const turn = mintTurnIceServers(callId, userId, { ttlS: RTC_TURN_TTL_S, secret: opts.secret, now: () => now }) ?? [];
  return {
    iceServers: [{ urls: [...RTC_STUN_URLS] }, ...turn.map((s) => ({ ...s, urls: [...TURN_URLS] }))],
    iceTransportPolicy: "all",
    expiresAt: Math.floor(now / 1000) + RTC_TURN_TTL_S,
  };
}

/** The sole calling media credential: P2P WebRTC with OL signaling (rtc:signal) and OL ICE. */
export function p2pMedia(callId: string, userId: string, ttlSec: number, now = Date.now()): CallMedia {
  const cfg = rtcIceConfig(callId, userId, { now: () => now });
  const turn = cfg.iceServers.filter((s): s is TurnIceServer => "credential" in s);
  return {
    provider: "p2p",
    url: "rtc",
    token: "", // OL session auth on the WebSocket is the credential; no media-server token exists.
    callId,
    expiresAt: Math.floor(now / 1000) + Math.min(ttlSec, RTC_TURN_TTL_S),
    ...(turn.length ? { iceServers: turn } : {}),
  };
}
