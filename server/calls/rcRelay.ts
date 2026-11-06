// Signal-model call relay on the OL calling droplet (replaces mediasoup PlainTransport + coturn-ladder orchestration).
// 1) PreKeyDirectory: public OLX3DH-v1 bundles (identity, signed prekey, one-time prekeys; OPK consumed on fetch).
// 2) RcRelay: opaque E2E-sealed call messages (`rc:msg`) between the two participants of a live call. The server
//    validates membership, size, rate and per-sender monotonic counters; it cannot read SDP/ICE (sealed client-side).
// Media is P2P WebRTC; relay transport is ICE/TURN credentials from rtcIceConfig.ts (TURN as ICE transport only).

export interface PublishedKeys { deviceId: string; ikDh: string; ikSig: string; spkId: number; spk: string; spkSig: string; opks: { id: number; pub: string }[] }
export interface Bundle { userId: string; deviceId: string; ikDh: string; ikSig: string; spkId: number; spk: string; spkSig: string; opkId?: number; opk?: string }
type DeviceRec = { keys: Omit<PublishedKeys, "opks" | "deviceId">; opks: { id: number; pub: string }[]; at: number };

/** Persistence seam (Postgres on droplet); in-memory default. Keyed per user → per device (Signal multi-device model). */
export interface PreKeyStore {
  get(userId: string): Promise<Record<string, DeviceRec> | null>;
  put(userId: string, v: Record<string, DeviceRec>): Promise<void>;
}
export const memoryPreKeyStore = (): PreKeyStore => { const m = new Map<string, Record<string, DeviceRec>>(); return { get: async (u) => m.get(u) ?? null, put: async (u, v) => void m.set(u, v) }; };

const B64U = /^[A-Za-z0-9_-]{43}$/; // 32-byte keys
const B64U_SIG = /^[A-Za-z0-9_-]{86}$/; // 64-byte Ed25519 sig
const DEV = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_OPKS = 200;
const MAX_DEVICES = 10;

export class PreKeyDirectory {
  private pending = new Map<string, Promise<unknown>>();
  private serial<T>(uid: string, work: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(uid) ?? Promise.resolve()).then(work);
    const settled = result.catch(() => {}); this.pending.set(uid, settled);
    void settled.then(() => { if (this.pending.get(uid) === settled) this.pending.delete(uid); });
    return result;
  }
  constructor(private store: PreKeyStore = memoryPreKeyStore(), private now: () => number = Date.now) {}

  async publish(userId: string, raw: unknown): Promise<{ ok: true; opkCount: number } | { ok: false; error: "bad_request" }> {
    const r = raw as PublishedKeys;
    if (!r || !DEV.test(r.deviceId) || !B64U.test(r.ikDh) || !B64U.test(r.ikSig) || !B64U.test(r.spk) || !B64U_SIG.test(r.spkSig) || !Number.isInteger(r.spkId) || !Array.isArray(r.opks) || r.opks.length > MAX_OPKS) return { ok: false, error: "bad_request" };
    if (!r.opks.every((o) => Number.isInteger(o?.id) && B64U.test(o?.pub))) return { ok: false, error: "bad_request" };
    return this.serial(userId, async () => {
    const all = (await this.store.get(userId)) ?? {};
    const prev = all[r.deviceId];
    // identity change wipes that device's old OPKs (reinstall); same identity appends
    const opks = prev && prev.keys.ikDh === r.ikDh ? [...prev.opks, ...r.opks].slice(-MAX_OPKS) : r.opks;
    all[r.deviceId] = { keys: { ikDh: r.ikDh, ikSig: r.ikSig, spkId: r.spkId, spk: r.spk, spkSig: r.spkSig }, opks, at: this.now() };
    const devs = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DEVICES);
    await this.store.put(userId, Object.fromEntries(devs));
    return { ok: true as const, opkCount: opks.length };
    });
  }

  /** one bundle per registered device of `userId`, each consuming one OPK */
  async fetch(userId: string): Promise<Bundle[]> {
    return this.serial(userId, async () => {
    const all = await this.store.get(userId);
    if (!all) return [];
    const out: Bundle[] = [];
    for (const [deviceId, v] of Object.entries(all)) {
      const opk = v.opks.shift();
      out.push({ userId, deviceId, ...v.keys, ...(opk ? { opkId: opk.id, opk: opk.pub } : {}) });
    }
    await this.store.put(userId, all);
    return out;
    });
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
    const peer = c ? (uid === c.callerId ? c.calleeId : c.callerId) : null;
    // userId optional (natives send callId only; server derives the peer); if given it must be the peer
    if (!peer || (raw.userId !== undefined && raw.userId !== peer)) return { ok: false as const, error: "not_participant" };
    const bundles = await this.keys.fetch(peer);
    return bundles.length ? { ok: true as const, bundles } : { ok: false as const, error: "no_keys" };
  }

  msg(uid: string, raw: unknown) {
    type Env = { v?: unknown; n?: unknown; ct?: unknown; pre?: unknown };
    // {callId, dev, envs: {peerDeviceId: Env}} — initiator fans out to every peer device until one answers (Signal multi-device)
    const m = raw as { callId?: unknown; dev?: unknown; envs?: Record<string, Env> };
    const envs = m?.envs && typeof m.envs === "object" ? Object.entries(m.envs) : [];
    if (typeof m?.dev !== "string" || !DEV.test(m.dev) || !envs.length || envs.length > MAX_DEVICES) return { ok: false, error: "bad_request" };
    let n = -1, size = 0;
    for (const [d, e] of envs) {
      if (!DEV.test(d) || !e || e.v !== 1 || !Number.isInteger(e.n) || (e.n as number) < 0 || typeof e.ct !== "string") return { ok: false, error: "bad_request" };
      n = Math.max(n, e.n as number); size += (e.ct as string).length;
    }
    if (size > MAX_CT) return { ok: false, error: "too_large" };
    const now = this.d.now?.() ?? Date.now();
    const ts = (this.rate.get(uid) ?? []).filter((t) => now - t < 10_000);
    if (ts.length >= RATE_PER_10S) return { ok: false, error: "rate_limited" };
    ts.push(now); this.rate.set(uid, ts);
    const c = this.member(m.callId, uid);
    if (!c) return { ok: false, error: "not_participant" };
    const k = `${m.callId}:${uid}:${m.dev}`;
    if (n <= (this.last.get(k) ?? -1)) return { ok: false, error: "replayed" };
    this.last.set(k, n);
    const peer = uid === c.callerId ? c.calleeId : c.callerId;
    this.d.emitUser(peer, "rc:msg", { callId: m.callId, dev: m.dev, envs: m.envs, from: uid === c.callerId ? "caller" : "callee" });
    return { ok: true };
  }

  end(callId: string) { for (const k of this.last.keys()) if (k.startsWith(`${callId}:`)) this.last.delete(k); }
}
