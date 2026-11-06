import type { CallMedia } from "../../src/lib/types";

/** One backend per call (P2P WebRTC + rcRelay sealed signaling + OL ICE/TURN creds); never migrated mid-call. */
export interface CallMediaBackend {
  readonly provider: CallMedia["provider"];
  issue(input: { callId: string; userId: string; name: string; ttlSec: number }): Promise<CallMedia | null>;
  /** Best-effort resource cleanup. It must never throw into call teardown. */
  close(callId: string): void;
}
