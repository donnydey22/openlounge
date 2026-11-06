// OL clean-room X3DH + symmetric-ratchet session for call signaling ("OLX3DH-v1").
// Behavioral model: libsignal session (identity key, signed prekey, one-time prekey, X3DH, per-message keys).
// NOT libsignal (AGPL) code. Byte-exact contract shared with Swift (OLX3DH.swift) and Kotlin (OlX3dh.kt):
//   SK  = HKDF-SHA256(ikm = 0xFF*32 || DH1 || DH2 || DH3 [|| DH4], salt = 0*32, info = "OLX3DH-v1", L = 32)
//   DH1 = DH(IKa, SPKb) DH2 = DH(EKa, IKb) DH3 = DH(EKa, SPKb) DH4 = DH(EKa, OPKb)
//   chains = HKDF(SK, salt = 0*32, info = "OLCallChain-v1", L = 64) → [0..32) initiator→responder, [32..64) responder→initiator
//   mk_n = HMAC(ck_n, 0x01); nonce_n = HMAC(ck_n, 0x03)[0..12); ck_{n+1} = HMAC(ck_n, 0x02)
//   header = 0x01 || u32be(n);  AAD = IKdh_initiator || IKdh_responder || header;  AES-256-GCM(mk_n, nonce_n)
//   SPK signature = Ed25519(IKsig, SPK public raw 32 bytes)
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64 = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
};
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const buf = (u: Uint8Array) => u.slice().buffer as ArrayBuffer;

export interface KeyPair { pub: Uint8Array; priv: CryptoKey; privJwk?: JsonWebKey }
export interface Identity { dh: KeyPair; sig: { pub: Uint8Array; priv: CryptoKey } }
export interface PreKeyBundle { userId: string; ikDh: string; ikSig: string; spkId: number; spk: string; spkSig: string; opkId?: number; opk?: string }

export async function genDh(): Promise<KeyPair> {
  const k = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { pub: new Uint8Array(await subtle.exportKey("raw", k.publicKey)), priv: k.privateKey, privJwk: await subtle.exportKey("jwk", k.privateKey) };
}
export async function genSig() {
  const k = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pub: new Uint8Array(await subtle.exportKey("raw", k.publicKey)), priv: k.privateKey, privJwk: await subtle.exportKey("jwk", k.privateKey) };
}
export async function importDhPriv(jwk: JsonWebKey) { return subtle.importKey("jwk", jwk, { name: "X25519" }, true, ["deriveBits"]); }
export async function importSigPriv(jwk: JsonWebKey) { return subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]); }

async function dh(priv: CryptoKey, pub: Uint8Array) {
  const p = await subtle.importKey("raw", buf(pub), { name: "X25519" }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: p }, priv, 256));
}
async function hkdf(ikm: Uint8Array, info: string, len: number) {
  const k = await subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) }, k, len * 8));
}
async function hmac(key: Uint8Array, b: number) {
  const k = await subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, new Uint8Array([b])));
}
export async function signSpk(sigPriv: CryptoKey, spkPub: Uint8Array) { return new Uint8Array(await subtle.sign("Ed25519", sigPriv, buf(spkPub))); }
export async function verifySpk(ikSig: Uint8Array, spk: Uint8Array, sig: Uint8Array) {
  const k = await subtle.importKey("raw", buf(ikSig), { name: "Ed25519" }, false, ["verify"]);
  return subtle.verify("Ed25519", k, buf(sig), buf(spk));
}

export interface PreKeyHeader { ikDh: string; ikSig: string; ek: string; spkId: number; opkId?: number }
export interface Envelope { v: 1; n: number; ct: string; pre?: PreKeyHeader }

/** Per-call session (Signal calling also derives fresh per-call state); skipped keys bounded for out-of-order delivery. */
export class OlSession {
  private sendN = 0;
  private recvN = 0;
  private skipped = new Map<number, Uint8Array>();
  constructor(private sendCk: Uint8Array, private recvCk: Uint8Array, private ad: Uint8Array, private pre?: PreKeyHeader) {}

  static async initiate(me: Identity, b: PreKeyBundle): Promise<OlSession> {
    const ikB = unb64(b.ikDh), spkB = unb64(b.spk);
    if (!(await verifySpk(unb64(b.ikSig), spkB, unb64(b.spkSig)))) throw new Error("olx3dh: bad signed prekey signature");
    const ek = await genDh();
    const parts = [new Uint8Array(32).fill(0xff), await dh(me.dh.priv, spkB), await dh(ek.priv, ikB), await dh(ek.priv, spkB)];
    if (b.opk) parts.push(await dh(ek.priv, unb64(b.opk)));
    const sk = await hkdf(cat(...parts), "OLX3DH-v1", 32);
    const ch = await hkdf(sk, "OLCallChain-v1", 64);
    return new OlSession(ch.slice(0, 32), ch.slice(32), cat(me.dh.pub, ikB), { ikDh: b64(me.dh.pub), ikSig: b64(me.sig.pub), ek: b64(ek.pub), spkId: b.spkId, opkId: b.opk ? b.opkId : undefined });
  }

  static async respond(me: Identity, spkPriv: CryptoKey, opkPriv: CryptoKey | null, h: PreKeyHeader): Promise<OlSession> {
    const ikA = unb64(h.ikDh), ek = unb64(h.ek);
    const parts = [new Uint8Array(32).fill(0xff), await dh(spkPriv, ikA), await dh(me.dh.priv, ek), await dh(spkPriv, ek)];
    if (opkPriv) parts.push(await dh(opkPriv, ek));
    const sk = await hkdf(cat(...parts), "OLX3DH-v1", 32);
    const ch = await hkdf(sk, "OLCallChain-v1", 64);
    return new OlSession(ch.slice(32), ch.slice(0, 32), cat(ikA, me.dh.pub));
  }

  private static header(n: number) { const h = new Uint8Array(5); h[0] = 1; new DataView(h.buffer).setUint32(1, n); return h; }

  async seal(plain: Uint8Array): Promise<Envelope> {
    const n = this.sendN++;
    const mk = await hmac(this.sendCk, 1), nonce = (await hmac(this.sendCk, 3)).slice(0, 12);
    this.sendCk = await hmac(this.sendCk, 2);
    const k = await subtle.importKey("raw", buf(mk), "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: cat(this.ad, OlSession.header(n)) }, k, buf(plain)));
    return { v: 1, n, ct: b64(ct), ...(this.pre ? { pre: this.pre } : {}) };
  }
  /** responder confirmed: stop attaching prekey header */
  confirmed() { this.pre = undefined; }

  async open(e: Envelope): Promise<Uint8Array> {
    if (e.v !== 1 || !Number.isInteger(e.n) || e.n < 0) throw new Error("olx3dh: bad envelope");
    let ck: Uint8Array | undefined;
    if (e.n < this.recvN) { ck = this.skipped.get(e.n); if (!ck) throw new Error("olx3dh: replay"); this.skipped.delete(e.n); }
    else {
      if (e.n - this.recvN > 256) throw new Error("olx3dh: too far ahead");
      while (this.recvN < e.n) { this.skipped.set(this.recvN++, this.recvCk); this.recvCk = await hmac(this.recvCk, 2); }
      ck = this.recvCk; this.recvCk = await hmac(this.recvCk, 2); this.recvN++;
      while (this.skipped.size > 256) this.skipped.delete(this.skipped.keys().next().value as number);
    }
    const mk = await hmac(ck, 1), nonce = (await hmac(ck, 3)).slice(0, 12);
    const k = await subtle.importKey("raw", buf(mk), "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: cat(this.ad, OlSession.header(e.n)) }, k, buf(unb64(e.ct))));
  }
}
