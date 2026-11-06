// OL-authenticated P2P signaling for calls: offer/answer/ICE candidates relayed between the two participants of a
// live call over the existing OL WebSocket. Mirrors Signal's call-message model (offer/answer/ice/hangup with a
// call generation) on OL identities/endpoints. No media server sits in the path.

export type RtcKind = "ready" | "offer" | "answer" | "candidate" | "restart" | "bye";
export const RTC_KINDS: readonly RtcKind[] = ["ready", "offer", "answer", "candidate", "restart", "bye"];

export type RtcErrorCode = "bad_request" | "not_participant" | "not_active" | "unknown_call" | "stale_generation" | "replayed" | "too_large" | "rate_limited";

export interface RtcSignal {
  callId: string;
  /** call-scoped generation; a newer generation (ICE restart / rejoin) supersedes older ones */
  gen: number;
  /** strictly increasing per sender per generation (replay guard) */
  seq: number;
  kind: RtcKind;
  sdp?: string;
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null;
}

export type RtcResult = { ok: true } | { ok: false; error: RtcErrorCode };

export interface RtcDeps {
  call(callId: string): { callerId: string; calleeId: string; phase: string } | null;
  emitUser(userId: string, ev: string, data: unknown): void;
  now?(): number;
}

const MAX_SDP = 64 * 1024;
const MAX_CAND = 2048;
const RATE_PER_10S = 200;

export class RtcSessionHub {
  private state = new Map<string, { gen: number; seq: Map<string, number> }>();
  private rate = new Map<string, number[]>();
  constructor(private d: RtcDeps) {}

  static parse(raw: unknown): RtcSignal | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.callId !== "string" || !r.callId || r.callId.length > 128) return null;
    if (!Number.isInteger(r.gen) || (r.gen as number) < 0 || !Number.isInteger(r.seq) || (r.seq as number) < 0) return null;
    if (!RTC_KINDS.includes(r.kind as RtcKind)) return null;
    const out: RtcSignal = { callId: r.callId, gen: r.gen as number, seq: r.seq as number, kind: r.kind as RtcKind };
    if (r.kind === "offer" || r.kind === "answer") {
      if (typeof r.sdp !== "string" || !r.sdp) return null;
      out.sdp = r.sdp;
    }
    if (r.kind === "candidate") {
      const c = r.candidate as Record<string, unknown> | null | undefined;
      if (c === null) out.candidate = null; // end-of-candidates
      else if (c && typeof c.candidate === "string") out.candidate = { candidate: c.candidate, sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null, sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null };
      else return null;
    }
    return out;
  }

  signal(userId: string, raw: unknown): RtcResult {
    const m = RtcSessionHub.parse(raw);
    if (!m) return { ok: false, error: "bad_request" };
    if ((m.sdp?.length ?? 0) > MAX_SDP || (m.candidate?.candidate.length ?? 0) > MAX_CAND) return { ok: false, error: "too_large" };
    if (!this.allow(userId)) return { ok: false, error: "rate_limited" };
    const c = this.d.call(m.callId);
    if (!c) return { ok: false, error: "unknown_call" };
    if (userId !== c.callerId && userId !== c.calleeId) return { ok: false, error: "not_participant" };
    if (c.phase !== "active" && m.kind !== "bye") return { ok: false, error: "not_active" };
    let st = this.state.get(m.callId);
    if (!st) this.state.set(m.callId, (st = { gen: m.gen, seq: new Map() }));
    if (m.gen < st.gen) return { ok: false, error: "stale_generation" };
    if (m.gen > st.gen) {
      st.gen = m.gen;
      st.seq.clear();
    }
    const last = st.seq.get(userId) ?? -1;
    if (m.seq <= last) return { ok: false, error: "replayed" };
    st.seq.set(userId, m.seq);
    const peer = userId === c.callerId ? c.calleeId : c.callerId;
    this.d.emitUser(peer, "rtc:signal", { ...m, from: userId === c.callerId ? "caller" : "callee" });
    return { ok: true };
  }

  /** call ended: drop generation/replay state */
  end(callId: string) {
    this.state.delete(callId);
  }

  private allow(userId: string) {
    const now = this.d.now?.() ?? Date.now();
    const arr = (this.rate.get(userId) ?? []).filter((t) => now - t < 10_000);
    if (arr.length >= RATE_PER_10S) return this.rate.set(userId, arr), false;
    arr.push(now);
    this.rate.set(userId, arr);
    return true;
  }
}
