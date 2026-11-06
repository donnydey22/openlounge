// Local identity/prekey store for OLX3DH-v1 (browser). Private keys stay on-device (IndexedDB-backed KV injected by the
// app; in-memory default for tests). Publishes public bundle to OL server (rc:keys:publish) — server never sees privates.
import { b64, genDh, genSig, importDhPriv, importSigPriv, signSpk, type Identity, type PreKeyBundle } from "./olx3dh";

export interface Kv { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; del(k: string): Promise<void> }
export const memoryKv = (): Kv => { const m = new Map<string, string>(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), del: async (k) => void m.delete(k) }; };

type StoredKp = { pub: string; jwk: JsonWebKey };
const OPK_BATCH = 20;

export class OlKeyStore {
  private ident: Identity | null = null;
  constructor(private kv: Kv) {}

  async identity(): Promise<Identity> {
    if (this.ident) return this.ident;
    const raw = await this.kv.get("olx3dh:ik");
    if (raw) {
      const s = JSON.parse(raw) as { dh: StoredKp; sig: StoredKp };
      const { unb64 } = await import("./olx3dh");
      this.ident = { dh: { pub: unb64(s.dh.pub), priv: await importDhPriv(s.dh.jwk) }, sig: { pub: unb64(s.sig.pub), priv: await importSigPriv(s.sig.jwk) } };
    } else {
      const d = await genDh(), g = await genSig();
      await this.kv.set("olx3dh:ik", JSON.stringify({ dh: { pub: b64(d.pub), jwk: d.privJwk }, sig: { pub: b64(g.pub), jwk: g.privJwk } }));
      this.ident = { dh: d, sig: g };
    }
    return this.ident;
  }

  /** Rotate signed prekey and top up one-time prekeys; returns the public upload payload. */
  async deviceId(): Promise<string> {
    let d = await this.kv.get("olx3dh:dev");
    if (!d) { d = b64(globalThis.crypto.getRandomValues(new Uint8Array(16))); await this.kv.set("olx3dh:dev", d); }
    return d;
  }

  async publishable(): Promise<{ deviceId: string; ikDh: string; ikSig: string; spkId: number; spk: string; spkSig: string; opks: { id: number; pub: string }[] }> {
    const id = await this.identity();
    const spkId = Number((await this.kv.get("olx3dh:spkNext")) ?? "1");
    const spk = await genDh();
    await this.kv.set(`olx3dh:spk:${spkId}`, JSON.stringify({ pub: b64(spk.pub), jwk: spk.privJwk }));
    await this.kv.set("olx3dh:spkNext", String(spkId + 1));
    const opks: { id: number; pub: string }[] = [];
    let next = Number((await this.kv.get("olx3dh:opkNext")) ?? "1");
    for (let i = 0; i < OPK_BATCH; i++, next++) {
      const k = await genDh();
      await this.kv.set(`olx3dh:opk:${next}`, JSON.stringify({ pub: b64(k.pub), jwk: k.privJwk }));
      opks.push({ id: next, pub: b64(k.pub) });
    }
    await this.kv.set("olx3dh:opkNext", String(next));
    return { deviceId: await this.deviceId(), ikDh: b64(id.dh.pub), ikSig: b64(id.sig.pub), spkId, spk: b64(spk.pub), spkSig: b64(await signSpk(id.sig.priv, spk.pub)), opks };
  }

  async spkPriv(id: number) { const r = await this.kv.get(`olx3dh:spk:${id}`); if (!r) throw new Error("olx3dh: unknown spk"); return importDhPriv((JSON.parse(r) as StoredKp).jwk); }
  /** one-time: deleted on use (forward secrecy / replay of the initial message fails) */
  async takeOpk(id?: number) {
    if (id == null) return null;
    const r = await this.kv.get(`olx3dh:opk:${id}`); if (!r) throw new Error("olx3dh: opk used or unknown");
    await this.kv.del(`olx3dh:opk:${id}`);
    return importDhPriv((JSON.parse(r) as StoredKp).jwk);
  }
}

export type { PreKeyBundle };

/** IndexedDB KV (browser). Private JWKs never leave the device. */
export function idbKv(db = "ol-rc-keys"): Kv {
  const open = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(db, 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest) => open().then((d) => new Promise<T>((res, rej) => { const q = f(d.transaction("kv", mode).objectStore("kv")); q.onsuccess = () => res(q.result as T); q.onerror = () => rej(q.error); }));
  return { get: (k) => run<string | undefined>("readonly", (s) => s.get(k)).then((v) => v ?? null), set: (k, v) => run("readwrite", (s) => s.put(v, k)).then(() => {}), del: (k) => run("readwrite", (s) => s.delete(k)).then(() => {}) };
}

let shared: OlKeyStore | null = null;
export const sharedKeyStore = () => (shared ??= new OlKeyStore(typeof indexedDB !== "undefined" ? idbKv() : memoryKv()));
