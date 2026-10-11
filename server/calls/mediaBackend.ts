import type { CallMedia } from "../../src/lib/types";

/** The call service captures one backend per call, so backend selection cannot change accidentally mid-call. */
export interface CallMediaBackend {
  readonly provider: CallMedia["provider"];
  issue(input: { callId: string; userId: string; name: string; ttlSec: number }): Promise<CallMedia | null>;
  /** Best-effort resource cleanup. It must never throw into call teardown. */
  close(callId: string): void;
  /**
   * Optional brokered Mediasoup signaling. The browser never talks directly to the SFU control channel;
   * the authenticated Open Lounge WebSocket supplies the call, user, and connection identity.
   */
  relay?(input: { callId: string; userId: string; connectionId: string; method: string; payload: Record<string, unknown>; token: string }): Promise<unknown>;
}
