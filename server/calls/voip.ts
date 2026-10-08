// iOS PushKit VoIP tokens + an APNs VoIP sender, for CallKit ringing while the iPhone app is closed/locked (build 18).
// Additive and inert until configured: tokens are stored as soon as build 18 registers them, but nothing is sent unless
// APNS_KEY_P8 (the EXISTING token-auth .p8 key, PEM text), APNS_KEY_ID, APNS_TEAM_ID and APNS_VOIP_TOPIC (or APNS_BUNDLE_ID,
// topic = <bundle>.voip) are set. Never creates, rotates or revokes Apple keys/certs.
import http2 from "node:http2";
import crypto from "node:crypto";
import pg from "pg";
import { chooseSsl } from "../pg";

export type ApnsEnv = "production" | "sandbox";
export interface VoipToken {
  token: string;
  userId: string;
  env: ApnsEnv;
}

export interface VoipStore {
  upsert(t: VoipToken): Promise<void>;
  remove(token: string, userId?: string): Promise<void>;
  tokensFor(userId: string): Promise<VoipToken[]>;
  deleteUser(userId: string): Promise<void>;
}

export class MemoryVoipStore implements VoipStore {
  tokens = new Map<string, VoipToken>();
  async upsert(t: VoipToken) {
    this.tokens.set(t.token, { ...t });
  }
  async remove(token: string, userId?: string) {
    const t = this.tokens.get(token);
    if (t && (!userId || t.userId === userId)) this.tokens.delete(token);
  }
  async tokensFor(userId: string) {
    return [...this.tokens.values()].filter((t) => t.userId === userId);
  }
  async deleteUser(userId: string) {
    for (const [k, t] of this.tokens) if (t.userId === userId) this.tokens.delete(k);
  }
}

export class PgVoipStore implements VoipStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const { connectionString, ssl } = chooseSsl(url);
    this.pool = new pg.Pool({ connectionString, ssl, max: 1, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", (e) => console.warn("[voip] pg idle error:", e.message));
  }
  async upsert(t: VoipToken) {
    await this.pool.query(
      `INSERT INTO voip_tokens (token, user_id, apns_env) VALUES ($1,$2,$3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, apns_env = EXCLUDED.apns_env, updated_at = now()`,
      [t.token, t.userId, t.env],
    );
  }
  async remove(token: string, userId?: string) {
    if (userId) await this.pool.query("DELETE FROM voip_tokens WHERE token = $1 AND user_id = $2", [token, userId]);
    else await this.pool.query("DELETE FROM voip_tokens WHERE token = $1", [token]);
  }
  async tokensFor(userId: string) {
    const r = await this.pool.query<{ token: string; user_id: string; apns_env: ApnsEnv }>("SELECT token, user_id, apns_env FROM voip_tokens WHERE user_id = $1", [userId]);
    return r.rows.map((x) => ({ token: x.token, userId: x.user_id, env: x.apns_env }));
  }
  async deleteUser(userId: string) {
    await this.pool.query("DELETE FROM voip_tokens WHERE user_id = $1", [userId]);
  }
}

/** PushKit tokens are 32 bytes → 64 hex chars; allow some headroom for future lengths. */
export function parseVoipToken(token: unknown, env: unknown): VoipToken | { error: string } {
  if (typeof token !== "string" || !/^[0-9a-fA-F]{64,200}$/.test(token)) return { error: "Invalid token" };
  return { token: token.toLowerCase(), userId: "", env: env === "sandbox" ? "sandbox" : "production" };
}

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
}

export function apnsConfigFromEnv(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const keyPem = (env.APNS_KEY_P8 ?? "").replace(/\\n/g, "\n").trim();
  const keyId = (env.APNS_KEY_ID ?? "").trim();
  const teamId = (env.APNS_TEAM_ID ?? "").trim();
  const topic = (env.APNS_VOIP_TOPIC ?? (env.APNS_BUNDLE_ID ? `${env.APNS_BUNDLE_ID.trim()}.voip` : "")).trim();
  if (!keyPem.includes("PRIVATE KEY") || !keyId || !teamId || !topic) return null;
  return { keyPem, keyId, teamId, topic };
}

export interface VoipSendResult {
  ok: boolean;
  status: number;
  reason?: string;
}
export interface VoipSender {
  send(t: VoipToken, payload: Record<string, string>, expiresAt: number): Promise<VoipSendResult>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** APNs provider API over HTTP/2 with an ES256 provider JWT (refreshed every 50 min; Apple allows 20–60). */
export class ApnsVoipSender implements VoipSender {
  private jwt = "";
  private jwtAt = 0;
  private sessions = new Map<string, http2.ClientHttp2Session>();
  constructor(
    private cfg: ApnsConfig,
    private now = () => Date.now(),
  ) {}

  providerToken() {
    if (this.jwt && this.now() - this.jwtAt < 50 * 60_000) return this.jwt;
    const iat = Math.floor(this.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "ES256", kid: this.cfg.keyId }));
    const body = b64url(JSON.stringify({ iss: this.cfg.teamId, iat }));
    const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: this.cfg.keyPem, dsaEncoding: "ieee-p1363" });
    this.jwt = `${head}.${body}.${b64url(sig)}`;
    this.jwtAt = this.now();
    return this.jwt;
  }

  private session(host: string) {
    const s = this.sessions.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    const n = http2.connect(`https://${host}`);
    n.on("error", (e) => console.warn("[voip] apns session error:", e.message));
    n.on("close", () => this.sessions.get(host) === n && this.sessions.delete(host));
    n.setTimeout(10 * 60_000, () => n.close());
    n.unref();
    this.sessions.set(host, n);
    return n;
  }

  send(t: VoipToken, payload: Record<string, string>, expiresAt: number): Promise<VoipSendResult> {
    const host = t.env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: VoipSendResult) => {
        if (!done) (done = true), resolve(r);
      };
      try {
        const req = this.session(host).request({
          ":method": "POST",
          ":path": `/3/device/${t.token}`,
          authorization: `bearer ${this.providerToken()}`,
          "apns-topic": this.cfg.topic,
          "apns-push-type": "voip",
          "apns-priority": "10",
          "apns-expiration": String(Math.max(0, Math.floor(expiresAt / 1000))),
          "content-type": "application/json",
        });
        let status = 0;
        let text = "";
        req.setEncoding("utf8");
        req.on("response", (h) => (status = Number(h[":status"]) || 0));
        req.on("data", (c: string) => (text += c));
        req.on("end", () => {
          let reason: string | undefined;
          try {
            reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
          } catch {}
          finish({ ok: status === 200, status, reason });
        });
        req.on("error", (e) => finish({ ok: false, status: 0, reason: e.message }));
        req.setTimeout(10_000, () => (req.close(), finish({ ok: false, status: 0, reason: "timeout" })));
        req.end(JSON.stringify({ aps: {}, ...payload }));
      } catch (e) {
        finish({ ok: false, status: 0, reason: (e as Error).message });
      }
    });
  }
}

/** Token is permanently bad → forget it (410 Unregistered, 400 BadDeviceToken/DeviceTokenNotForTopic). */
export const deadToken = (r: VoipSendResult) => r.status === 410 || (r.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(r.reason ?? ""));

export class Voip {
  constructor(
    public store: VoipStore,
    private sender: VoipSender | null,
    private log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}
  get enabled() {
    return !!this.sender;
  }
  async register(userId: string, token: unknown, env: unknown) {
    const t = parseVoipToken(token, env);
    if ("error" in t) return { ok: false as const, error: t.error };
    await this.store.upsert({ ...t, userId });
    return { ok: true as const };
  }
  async unregister(userId: string, token: unknown) {
    if (typeof token === "string") await this.store.remove(token.toLowerCase(), userId);
    return { ok: true as const };
  }
  /** Ring every iPhone of the callee via CallKit. Returns how many devices accepted the push. */
  async ring(userId: string, payload: Record<string, string>, expiresAt: number) {
    if (!this.sender) return 0;
    const tokens = await this.store.tokensFor(userId);
    let sent = 0;
    await Promise.all(
      tokens.map(async (t) => {
        const r = await this.sender!.send(t, payload, expiresAt);
        if (r.ok) sent++;
        else {
          this.log("voip push failed", { status: r.status, reason: r.reason });
          if (deadToken(r)) await this.store.remove(t.token).catch(() => {});
        }
      }),
    );
    return sent;
  }
}

let voip: Voip | null = null;
export function initVoip(opts: { store?: VoipStore; sender?: VoipSender | null; log?: (m: string, e?: Record<string, unknown>) => void } = {}) {
  const store = opts.store ?? (process.env.DATABASE_URL ? new PgVoipStore(process.env.DATABASE_URL) : new MemoryVoipStore());
  const cfg = apnsConfigFromEnv();
  const sender = opts.sender !== undefined ? opts.sender : cfg ? new ApnsVoipSender(cfg) : null;
  voip = new Voip(store, sender, opts.log);
  console.log(`[voip] ${sender ? `APNs VoIP pushes on (topic ${cfg?.topic ?? "custom"})` : "APNs VoIP not configured — tokens stored, no VoIP pushes"}`);
  return voip;
}
export const voipService = () => voip;
