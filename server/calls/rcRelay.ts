// Signal-model call relay on the OL calling droplet (replaces mediasoup PlainTransport + coturn-ladder orchestration).
// 1) PreKeyDirectory: public OLX3DH-v1 bundles (identity, signed prekey, one-time prekeys; OPK consumed on fetch).
// 2) RcRelay: opaque E2E-sealed call messages (`rc:msg`) between the two participants of a live call. The server
//    validates membership, size, rate and per-sender monotonic counters; it cannot read SDP/ICE (sealed client-side).
// Media is P2P WebRTC; relay transport is ICE/TURN credentials from rtcIceConfig.ts (TURN as ICE transport only).

export interface PublishedKeys { ikDh: string; ikSig: string; spkId: number; spk: string; spkSig: string; opks: { id: number; pub: string }[] }
export interface Bundle { userId: string; ikDh: string; ikSig: string; spkId: number; spk: string; spkSig: string; opkId?: number; opk?: string }

/** Persistence seam (Postgres on droplet); in-memory default. */
export interface PreKeyStore {
  get(userId: string): Promise<{ keys: Omit<PublishedKeys, "opks">; opks: { id: number; pub: string }[] } | null>;
  put(userId: string, v: { keys: Omit<PublishedKeys, "opks">; opks: { id: number; pub: string }[] }): Promise<void>;
}
export const memoryPreKeyStore = (): PreKeyStore => { const m = new Map<string, any>(); return { get: async (u) => m.get(u) ?? null, put: async (u, v) => void m.set(u, v) }; };

const B64U = /^[A-Za-z0-9_-]{43}$/; // 32-byte keys
const B64U_SIG = /^[A-Za-z0-9_-]{86}$/; // 64-byte Ed25519 sig
const MAX_OPKS = 200;

export class PreKeyDirectory {
  constructor(private store: PreKeyStore = memoryPreKeyStore()) {}

  async publish(userId: string, raw: unknown): Promise<{ ok: true; opkCount: number } | { ok: false; error: "bad_request" }> {
    const r = raw as PublishedKeys;
    if (!r || !B64U.test(r.ikDh) || !B64U.test(r.ikSig) || !B64U.test(r.spk) || !B64U_SIG.test(r.spkSig) || !Number.isInteger(r.spkId) || !Array.isArray(r.opks) || r.opks.length > MAX_OPKS) return { ok: false, error: "bad_request" };
    if (!r.opks.every((o) => Number.isInteger(o?.id) && B64U.test(o?.pub))) return { ok: false, error: "bad_request" };
    const prev = await this.store.get(userId);
    // identity change wipes old OPKs (new device install); same identity appends
    const opks = prev && prev.keys.ikDh === r.ikDh ? [...prev.opks, ...r.opks].slice(-MAX_OPKS) : r.opks;
    await this.store.put(userId, { keys: { ikDh: r.ikDh, ikSig: r.ikSig, spkId: r.spkId, spk: r.spk, spkSig: r.spkSig }, opks });
    return { ok: true, opkCount: opks.length };
  }

  async fetch(userId: string): Promise<Bundle | null> {
    const v = await this.store.get(userId);
    if (!v) return null;
    const opk = v.opks.shift();
    await this.store.put(userId, v);
    return { userId, ...v.keys, ...(opk ? { opkId: opk.id, opk: opk.pub } : {}) };
  }
}

export interface RcDeps {
  call(callId: string): { callerId: string; calleeId: string; phase: string } | null;
  emitUser(userId: string, ev: string, data: unknown): void;
  now?(): number;
}
const MAX_CT = 96 * 1024;
const RATE_PER_10S = 300;

export class RcRelay {
  private last = new Map<string, number>(); // `${callId}:${userId}` → last n
  private rate = new Map<string, number[]>();
  constructor(private d: RcDeps, readonly keys = new PreKeyDirectory()) {}

  private member(callId: unknown, uid: string) {
    const c = typeof callId === "string" ? this.d.call(callId) : null;
    return c && (uid === c.callerId || uid === c.calleeId) && c.phase !== "ended" ? c : null;
  }

  /** bundle fetch is only allowed for the peer of a call you are in (prevents OPK draining / directory scraping) */
  async fetchFor(uid: string, raw: { userId?: unknown; callId?: unknown }) {
    const c = this.member(raw?.callId, uid);
    if (!c || typeof raw.userId !== "string" || raw.userId !== (uid === c.callerId ? c.calleeId : c.callerId)) return { ok: false as const, error: "not_participant" };
    const bundle = await this.keys.fetch(raw.userId);
    return bundle ? { ok: true as const, bundle } : { ok: false as const, error: "no_keys" };
  }

  msg(uid: string, raw: unknown) {
    const m = raw as { callId?: unknown; env?: { v?: unknown; n?: unknown; ct?: unknown; pre?: unknown } };
    if (!m?.env || m.env.v !== 1 || !Number.isInteger(m.env.n) || (m.env.n as number) < 0 || typeof m.env.ct !== "string") return { ok: false, error: "bad_request" };
    if ((m.env.ct as string).length > MAX_CT) return { ok: false, error: "too_large" };
    const now = this.d.now?.() ?? Date.now();
    const ts = (this.rate.get(uid) ?? []).filter((t) => now - t < 10_000);
    if (ts.length >= RATE_PER_10S) return { ok: false, error: "rate_limited" };
    ts.push(now); this.rate.set(uid, ts);
    const c = this.member(m.callId, uid);
    if (!c) return { ok: false, error: "not_participant" };
    const k = `${m.callId}:${uid}`;
    if ((m.env.n as number) <= (this.last.get(k) ?? -1)) return { ok: false, error: "replayed" };
    this.last.set(k, m.env.n as number);
    const peer = uid === c.callerId ? c.calleeId : c.callerId;
    this.d.emitUser(peer, "rc:msg", { callId: m.callId, env: m.env, from: uid === c.callerId ? "caller" : "callee" });
    return { ok: true };
  }

  end(callId: string) { for (const k of this.last.keys()) if (k.startsWith(`${callId}:`)) this.last.delete(k); }
}
