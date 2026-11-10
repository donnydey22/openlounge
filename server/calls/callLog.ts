// Open Lounge call log (Donny t5375, 2026-11-10): every OL call, every user, durable and reviewable after the fact.
//
// One row per event in Postgres `call_events` (Railway; survives restarts/redeploys), 90-day retention. Sources:
//   android / ios  client six-state machine (idle, joining, offering, answering, connected, failed) + engine events,
//                  batched from each phone's on-disk queue:  POST /api/call-log  {events:[...]}
//                  auth: the app session (Authorization: Bearer <access>) OR the call's own olcall join token
//                  ({olcallToken}; signature checked with OLCALL_TOKEN_SECRET, accepted up to 7 days past exp, and only
//                  for that token's callId + userId). No new client secret.
//   railway        call start / ring / ack / accept / decline / hangup / timeout / end (CallService log hook)
//   pion           read at review time from the droplet's breadcrumb JSONL (GET /v1/crumbs, HMAC-signed read)
// Review (admin only; app admin bearer or X-Call-Log-Key = CALL_LOG_REVIEW_KEY):
//   GET /api/admin/call-log?call=<id>               one call: summary (device matrix, path, outcome, failure tags) + timeline
//   GET /api/admin/call-log?user=<id>&since=<ms>    calls of a user (summaries)
//   GET /api/admin/call-log?since=<ms>&matrix=1     recent calls + device-matrix rollup
// Without DATABASE_URL (local dev/tests) or while Postgres is unreachable, events go to an append-only JSONL spool in
// DATA_DIR/call-log (drained into Postgres when it is back). Never stores tokens, keys, blobs, SDP or TURN credentials.
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import pg from "pg";
import { chooseSsl } from "../pg";
import { olcallSecret, type OlcallClaims } from "./olcallToken";

export const CALL_STATES = ["idle", "joining", "offering", "answering", "connected", "failed"] as const;
export type CallState = (typeof CALL_STATES)[number];
/** Failure tags Donny asked for (every failed transition carries exactly one). */
export const FAILURE_TAGS = ["offer_never_sent", "answer_timeout", "connection_stalled", "ice_failure", "audio_session_handoff_failure", "turn_relay_failure"] as const;
/** Kept as their own tags (not failures of the call engine itself). */
export const EXTRA_TAGS = ["permission_denied", "engine_unavailable", "join_rejected", "cancelled"] as const;
export type FailureTag = (typeof FAILURE_TAGS)[number] | (typeof EXTRA_TAGS)[number];
const TAG_SET = new Set<string>([...FAILURE_TAGS, ...EXTRA_TAGS]);

export const RETENTION_DAYS = Number(process.env.CALL_LOG_RETENTION_DAYS || 90);
export const TOKEN_GRACE_S = 7 * 24 * 3600;
export const LIMITS = { batch: 200, bodyBytes: 262_144, str: 160, extraKeys: 24 } as const;

/**
 * Raw engine/close reason -> failure tag. Same table as Android OlCallLog.tag and iOS OLCallLog.tag.
 * Raw reasons are OlCallStates.diagnose() output ("<where>:<cause>"), Pion close reasons, or app-level reasons.
 */
export function failureTag(raw: unknown, ctx: { turnServers?: number | null; relayOnly?: boolean } = {}): FailureTag {
  const r = String(raw ?? "").toLowerCase().trim();
  if (TAG_SET.has(r)) return r as FailureTag;
  if (/audio[-_ ]?session|audio[-_ ]?open|adm[-_:]|avaudiosession|audio[-_ ]?unit|mic(rophone)?[-_ ]?(open|unavailable)|audio-focus/.test(r)) return "audio_session_handoff_failure";
  if (/permission/.test(r)) return "permission_denied";
  if (/olcall-unavailable|engine[-_ ]?unavailable|native-create|media_unavailable|olcall_unavailable/.test(r)) return "engine_unavailable";
  if (/cancel/.test(r)) return "cancelled";
  if (/no[-_ ]?turn|turn[-_ ]?(alloc|relay|cred|auth|fail|401|403|438)|relay[-_ ]?(fail|alloc)|allocation/.test(r)) return "turn_relay_failure";
  if (/unauthori[sz]ed|join[-_ ]?rejected|bad[-_ ]?token|server[-_ ]?full|slot taken/.test(r)) return "join_rejected";
  if (r.startsWith("offer-never-sent") || r.startsWith("offer-never-arrived") || r.includes("offer_never_sent")) return "offer_never_sent";
  if (r.startsWith("answer-never-arrived") || r.startsWith("answer-never-sent") || /answer[-_ ]?time|join-timeout|no[-_ ]?answer/.test(r)) return "answer_timeout";
  if (/ice/.test(r) || /tg-failed|dtls/.test(r)) {
    if (ctx.turnServers === 0 || ctx.relayOnly) return "turn_relay_failure";
    return r.startsWith("ice-stalled:ws") ? "connection_stalled" : "ice_failure";
  }
  return "connection_stalled"; // join-never-acked, ws-failure/closed, after-connect drop, timeouts, unknown
}

export type CallLogEvent = {
  eventId: string; callId: string; userId: string | null; role: string | null;
  source: "android" | "ios" | "web" | "railway" | "pion";
  platform: string | null; device: string | null; os: string | null; appVersion: string | null; engine: string | null;
  media: "audio" | "video" | null; kind: "state" | "event"; event: string | null;
  fromState: CallState | null; toState: CallState | null; reason: string | null; detail: string | null;
  tsClient: number | null; tCallMs: number | null; tsServer: number; extra: Record<string, string | number | boolean>;
};

const SECRETISH = /(token|secret|password|passwd|pwd|credential|key|sdp|blob|b64|ufrag|cookie|auth)/i;
const LONG_B64 = /[A-Za-z0-9+/_=-]{80,}/;
const clean = (v: unknown, n: number = LIMITS.str): string | null => {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  if (!s || LONG_B64.test(s)) return null;
  return s;
};
const id = (v: unknown, n = 80) => { const s = typeof v === "string" ? v.trim() : ""; return /^[A-Za-z0-9_.:-]{1,80}$/.test(s) ? s.slice(0, n) : null; };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : null);
const state = (v: unknown): CallState | null => (CALL_STATES as readonly string[]).includes(String(v)) ? (v as CallState) : null;

function cleanExtra(x: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>).slice(0, LIMITS.extraKeys * 2)) {
    if (Object.keys(out).length >= LIMITS.extraKeys) break;
    const key = k.replace(/[^\w.-]/g, "").slice(0, 32);
    if (!key || SECRETISH.test(key)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
    else { const s = clean(v); if (s !== null) out[key] = s; }
  }
  return out;
}

/** Validate one client event. Unknown/garbage -> null. A failed transition always leaves with a tag in `reason`. */
export function sanitizeClientEvent(e: unknown, who: { userId: string; callId?: string | null }, now = Date.now()): CallLogEvent | null {
  if (!e || typeof e !== "object") return null;
  const x = e as Record<string, unknown>;
  const callId = id(x.callId) ?? (who.callId ?? null);
  if (!callId) return null;
  if (who.callId && callId !== who.callId) return null; // an olcall token only vouches for its own call
  const src = String(x.source ?? x.platform ?? "").toLowerCase();
  const source = src === "ios" ? "ios" : src === "android" ? "android" : src === "web" ? "web" : null;
  if (!source) return null;
  const kind = x.kind === "state" ? "state" : "event";
  const fromState = state(x.from ?? x.fromState), toState = state(x.to ?? x.toState);
  if (kind === "state" && !toState) return null;
  const extra = cleanExtra(x.extra);
  let reason = clean(x.reason, 64), detail = clean(x.detail ?? x.rawReason, 240);
  if (toState === "failed") {
    const tag = failureTag(reason && TAG_SET.has(reason) ? reason : (detail ?? reason), { turnServers: num(extra.turnServers), relayOnly: extra.relayOnly === true });
    if (!detail && reason && !TAG_SET.has(reason)) detail = reason;
    reason = tag;
  }
  const media = x.media === "video" ? "video" : x.media === "audio" ? "audio" : null;
  const role = x.role === "caller" || x.role === "callee" ? x.role : null;
  return {
    eventId: id(x.eventId, 64) ?? randomUUID(), callId, userId: who.userId, role, source,
    platform: clean(x.platform, 16) ?? source, device: clean(x.device, 80), os: clean(x.os, 48), appVersion: clean(x.appVersion, 32), engine: clean(x.engine, 64),
    media, kind, event: clean(x.event, 64), fromState, toState, reason, detail,
    tsClient: num(x.ts ?? x.tsClient), tCallMs: num(x.t ?? x.tCallMs), tsServer: now, extra,
  };
}

// ------------------------------------------------------------------ token auth (olcall join token, signature + grace)
export function verifyOlcallTokenForLog(token: unknown, secret: Buffer | null = olcallSecret(), now = Date.now()): OlcallClaims | null {
  if (!secret || typeof token !== "string" || token.length > 600) return null;
  const [p1, sig, more] = token.split(".");
  if (!p1 || !sig || more !== undefined) return null;
  const want = createHmac("sha256", secret).update(p1).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(p1, "base64url").toString("utf8")) as OlcallClaims;
    if (!c.callId || !c.userId || (c.role !== "caller" && c.role !== "callee") || !Number.isInteger(c.exp)) return null;
    if (now / 1000 > c.exp + TOKEN_GRACE_S) return null;
    return c;
  } catch { return null; }
}

// ------------------------------------------------------------------ storage
const DDL = `
CREATE TABLE IF NOT EXISTS call_events (
  seq BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  call_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT,
  source TEXT NOT NULL,
  platform TEXT, device TEXT, os TEXT, app_version TEXT, engine TEXT, media TEXT,
  kind TEXT NOT NULL,
  event TEXT,
  from_state TEXT, to_state TEXT, reason TEXT, detail TEXT,
  ts_client BIGINT, t_call_ms BIGINT,
  ts_server BIGINT NOT NULL,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS call_events_call_idx ON call_events (call_id, ts_server);
CREATE INDEX IF NOT EXISTS call_events_user_idx ON call_events (user_id, ts_server);
CREATE INDEX IF NOT EXISTS call_events_ts_idx ON call_events (ts_server);
COMMENT ON TABLE call_events IS 'OL call log (t5375): six-state machine per leg + server events; 90-day retention (server/calls/callLog.ts)';`;

const COLS = ["event_id", "call_id", "user_id", "role", "source", "platform", "device", "os", "app_version", "engine", "media", "kind", "event", "from_state", "to_state", "reason", "detail", "ts_client", "t_call_ms", "ts_server", "extra"] as const;
const rowOf = (e: CallLogEvent) => [e.eventId, e.callId, e.userId, e.role, e.source, e.platform, e.device, e.os, e.appVersion, e.engine, e.media, e.kind, e.event, e.fromState, e.toState, e.reason, e.detail, e.tsClient, e.tCallMs, e.tsServer, JSON.stringify(e.extra)];
type DbRow = { event_id: string; call_id: string; user_id: string | null; role: string | null; source: string; platform: string | null; device: string | null; os: string | null; app_version: string | null; engine: string | null; media: string | null; kind: string; event: string | null; from_state: string | null; to_state: string | null; reason: string | null; detail: string | null; ts_client: number | null; t_call_ms: number | null; ts_server: number; extra: Record<string, string | number | boolean> };
const fromRow = (r: DbRow): CallLogEvent => ({ eventId: r.event_id, callId: r.call_id, userId: r.user_id, role: r.role, source: r.source as CallLogEvent["source"], platform: r.platform, device: r.device, os: r.os, appVersion: r.app_version, engine: r.engine, media: r.media as CallLogEvent["media"], kind: r.kind as CallLogEvent["kind"], event: r.event, fromState: r.from_state as CallState | null, toState: r.to_state as CallState | null, reason: r.reason, detail: r.detail, tsClient: r.ts_client === null ? null : Number(r.ts_client), tCallMs: r.t_call_ms === null ? null : Number(r.t_call_ms), tsServer: Number(r.ts_server), extra: r.extra ?? {} });

export interface CallLogQuery { callId?: string; userId?: string; since?: number; until?: number; limit?: number }

export class CallLogStore {
  private pool: pg.Pool | null = null;
  private ready: Promise<boolean> | null = null;
  private lastPrune = 0;
  private draining = false;
  readonly dir: string;
  constructor(private opts: { databaseUrl?: string | null; dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? process.env.CALL_LOG_DIR ?? path.join(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data")), "call-log");
    const url = opts.databaseUrl === undefined ? process.env.DATABASE_URL : opts.databaseUrl;
    if (url) {
      const { ssl, connectionString } = chooseSsl(url);
      this.pool = new pg.Pool({ connectionString, ssl, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000, statement_timeout: 10_000, application_name: "openlounge-calllog" });
      this.pool.on("error", () => {});
    }
  }
  get kind() { return this.pool ? "postgres" : "jsonl"; }
  private now() { return this.opts.now?.() ?? Date.now(); }

  private init(): Promise<boolean> {
    if (!this.pool) return Promise.resolve(false);
    if (!this.ready) this.ready = this.pool.query(DDL).then(() => true, (err) => { this.ready = null; throw err; });
    return this.ready;
  }

  /** Durable write: Postgres, else the JSONL spool (fsync'd). Never throws. Returns where it went. */
  async add(events: CallLogEvent[]): Promise<"postgres" | "jsonl" | "none"> {
    if (!events.length) return "none";
    if (this.pool) {
      try {
        await this.init();
        await this.insert(events);
        void this.maybePrune();
        void this.drainSpool();
        return "postgres";
      } catch { /* fall through to the spool */ }
    }
    this.spool(events);
    return "jsonl";
  }

  private async insert(events: CallLogEvent[]) {
    const vals: unknown[] = [];
    const rows = events.map((e, i) => { vals.push(...rowOf(e)); return `(${COLS.map((_, j) => `$${i * COLS.length + j + 1}`).join(",")})`; });
    await this.pool!.query(`INSERT INTO call_events (${COLS.join(",")}) VALUES ${rows.join(",")} ON CONFLICT (event_id) DO NOTHING`, vals);
  }

  private spoolFile(day = new Date(this.now()).toISOString().slice(0, 10)) { return path.join(this.dir, `call-events-${day}.jsonl`); }
  private spool(events: CallLogEvent[]) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const fd = fs.openSync(this.spoolFile(), "a", 0o640);
      try { fs.writeSync(fd, events.map((e) => JSON.stringify(e)).join("\n") + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* last resort: the Railway log line below still carries it */ }
  }
  private spoolFiles() {
    try { return fs.readdirSync(this.dir).filter((f) => /^call-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  }
  private readSpool(): CallLogEvent[] {
    const out: CallLogEvent[] = [];
    for (const f of this.spoolFiles()) {
      try { for (const l of fs.readFileSync(path.join(this.dir, f), "utf8").split("\n")) if (l.trim()) try { out.push(JSON.parse(l)); } catch { /* torn line */ } } catch { /* gone */ }
    }
    return out;
  }
  /** Postgres is back: move spooled events in (idempotent by event_id), then remove the spool files. */
  async drainSpool() {
    if (!this.pool || this.draining) return;
    const files = this.spoolFiles();
    if (!files.length) return;
    this.draining = true;
    try {
      for (const f of files) {
        const p = path.join(this.dir, f);
        const evs: CallLogEvent[] = [];
        for (const l of fs.readFileSync(p, "utf8").split("\n")) if (l.trim()) try { evs.push(JSON.parse(l)); } catch { /* torn */ }
        for (let i = 0; i < evs.length; i += 200) await this.insert(evs.slice(i, i + 200));
        fs.renameSync(p, p + ".drained");
      }
    } catch { /* retry next time */ } finally { this.draining = false; }
  }

  async maybePrune(force = false) {
    const now = this.now();
    if (!force && now - this.lastPrune < 3_600_000) return;
    this.lastPrune = now;
    const cutoff = now - RETENTION_DAYS * 86_400_000;
    if (this.pool) await this.pool.query("DELETE FROM call_events WHERE ts_server < $1", [cutoff]).catch(() => {});
    const cutDay = new Date(cutoff).toISOString().slice(0, 10);
    try { for (const f of fs.readdirSync(this.dir)) { const d = f.match(/^call-events-(\d{4}-\d{2}-\d{2})\.jsonl/)?.[1]; if (d && d < cutDay) fs.rmSync(path.join(this.dir, f), { force: true }); } } catch { /* no dir */ }
  }

  async query(q: CallLogQuery): Promise<CallLogEvent[]> {
    const limit = Math.max(1, Math.min(20_000, q.limit ?? 5_000));
    const since = q.since ?? this.now() - RETENTION_DAYS * 86_400_000, until = q.until ?? Number.MAX_SAFE_INTEGER;
    let out: CallLogEvent[] = [];
    if (this.pool) {
      try {
        await this.init();
        const w: string[] = ["ts_server >= $1", "ts_server <= $2"]; const v: unknown[] = [since, until];
        if (q.callId) { v.push(q.callId); w.push(`call_id = $${v.length}`); }
        if (q.userId) { v.push(q.userId); w.push(`call_id IN (SELECT DISTINCT call_id FROM call_events WHERE user_id = $${v.length} AND ts_server >= $1)`); }
        v.push(limit);
        out = (await this.pool.query<DbRow>(`SELECT * FROM call_events WHERE ${w.join(" AND ")} ORDER BY ts_server, seq LIMIT $${v.length}`, v)).rows.map(fromRow);
      } catch { out = []; }
    }
    // spooled (not yet drained) events are part of the record too
    const spooled = this.readSpool().filter((e) => e.tsServer >= since && e.tsServer <= until && (!q.callId || e.callId === q.callId));
    const userCalls = q.userId ? new Set([...out, ...spooled].filter((e) => e.userId === q.userId).map((e) => e.callId)) : null;
    const seen = new Set(out.map((e) => e.eventId));
    for (const e of spooled) if (!seen.has(e.eventId) && (!userCalls || userCalls.has(e.callId))) out.push(e);
    return out.sort((a, b) => a.tsServer - b.tsServer).slice(0, limit);
  }

  async close() { await this.pool?.end().catch(() => {}); }
}

let shared: CallLogStore | null = null;
export const callLog = () => (shared ??= new CallLogStore());
export const setCallLogStore = (s: CallLogStore | null) => { shared = s; };

// ------------------------------------------------------------------ Railway server events (CallService log hook)
const SERVER_EVENTS: Record<string, string> = {
  "call start": "call_start", "call ring emit": "ring_emit", "call ring ack": "ring_ack", "call accept": "call_accept", "call end": "call_end",
  "call ring timeout": "ring_timeout", "call busy": "busy", "call repush": "repush", "call ack fallback push": "ack_fallback_push",
  "call ring backgrounded push": "ring_backgrounded_push", "call stale redial": "stale_redial", "call peer offline": "peer_offline",
  "call peer back": "peer_back", "call peer unreachable": "peer_unreachable", "call lost": "call_lost", "call peer detached": "peer_detached",
  "call peer reattached": "peer_reattached", "call detached": "detached", "call quality": "quality", "call metric": "metric",
  "socket closed during call": "socket_closed_during_call", "client diag": "client_diag", "call caller detached": "caller_detached",
};
let seqN = 0;
/** One CallService log line -> one durable server event (only lines that name a call). Fire-and-forget. */
export function recordServerEvent(msg: string, extra: Record<string, unknown> | undefined, store: CallLogStore = callLog(), now = Date.now()) {
  const ev = SERVER_EVENTS[msg];
  const callId = id(extra?.callId);
  if (!ev || !callId) return null;
  const x = { ...(extra ?? {}) };
  delete x.callId;
  const userId = id(x.userId) ?? null;
  const e: CallLogEvent = {
    eventId: `rw-${now.toString(36)}-${(seqN++).toString(36)}-${randomUUID().slice(0, 8)}`, callId, userId, role: null, source: "railway",
    platform: "server", device: null, os: null, appVersion: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? null, engine: "railway-calls",
    media: x.video === true ? "video" : x.video === false ? "audio" : null, kind: "event", event: ev, fromState: null, toState: null,
    reason: clean(x.reason ?? x.outcome, 64), detail: null, tsClient: null, tCallMs: null, tsServer: now, extra: cleanExtra(x),
  };
  void store.add([e]);
  return e;
}

// ------------------------------------------------------------------ Pion (droplet) breadcrumbs, read at review time
export function pionReadSig(secret: Buffer, callId: string, exp: number) {
  return createHmac("sha256", secret).update(`olcall-crumbs-read\n${callId}\n${exp}`).digest("base64url");
}
type Crumb = { ts?: string; callId?: string; leg?: string; category?: string; message?: string; level?: string; source?: string; platform?: string; device?: string };
export async function fetchPionCrumbs(callId: string, env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; crumbs: Crumb[]; error?: string }> {
  const secret = olcallSecret(env); const url = env.OLCALL_URL ?? "";
  if (!secret || !/^wss?:\/\//.test(url)) return { ok: false, crumbs: [], error: "not_configured" };
  const exp = Math.floor(Date.now() / 1000) + 120;
  const base = url.replace(/^ws/, "http").replace(/\/v1\/call$/, "/v1/crumbs");
  try {
    const r = await fetchFn(`${base}?callId=${encodeURIComponent(callId)}&exp=${exp}&sig=${pionReadSig(secret, callId, exp)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, crumbs: [], error: `http_${r.status}` };
    const j = (await r.json()) as { crumbs?: Crumb[] };
    return { ok: true, crumbs: Array.isArray(j.crumbs) ? j.crumbs.slice(0, 5000) : [] };
  } catch (e) { return { ok: false, crumbs: [], error: (e as Error).name || "fetch" }; }
}

/** Pion crumbs -> per-leg server-side state rows + the media path (relay vs direct) Pion's ICE agent selected. */
export function pionTimeline(crumbs: Crumb[]) {
  const legs: Record<string, { states: { to: CallState; reason: string; ts: string }[]; path: string | null; client: string | null; closed: string | null }> = {};
  for (const c of crumbs) {
    const leg = c.leg || "?"; const m = `${c.category ?? ""}:${c.message ?? ""}`;
    const L = (legs[leg] ??= { states: [], path: null, client: null, closed: null });
    const last = L.states.at(-1)?.to;
    if (m.startsWith("ws:join:")) L.states.push({ to: "joining", reason: "ws-join", ts: c.ts ?? "" });
    else if (m.startsWith("ws:meta:")) L.client = c.message!.slice(5);
    else if (m === "ice:connected" || m === "web.pc:connected") { if (last !== "connected") L.states.push({ to: "connected", reason: "pion-ice-connected", ts: c.ts ?? "" }); }
    else if (m.startsWith("ice:selected:")) { const remote = /remote=(\w+)/.exec(m)?.[1] ?? ""; L.path = remote === "relay" ? "relay" : remote ? "direct" : null; }
    else if (m.startsWith("leg:closed:")) {
      L.closed = m.slice(11);
      const normal = /hangup|leg-closed|ws-closed-grace|^ice-Closed$/.test(L.closed);
      if (!L.states.some((s) => s.to === "connected") && !normal) L.states.push({ to: "failed", reason: failureTag(L.closed), ts: c.ts ?? "" });
    }
  }
  return legs;
}

// ------------------------------------------------------------------ review: per-call summary + device matrix
export function summarizeCall(callId: string, events: CallLogEvent[], pion?: ReturnType<typeof pionTimeline>) {
  const evs = events.filter((e) => e.callId === callId);
  const rw = evs.filter((e) => e.source === "railway");
  const start = rw.find((e) => e.event === "call_start");
  const callerId = (start?.extra.callerId as string) ?? evs.find((e) => e.role === "caller")?.userId ?? null;
  const calleeId = (start?.extra.calleeId as string) ?? evs.find((e) => e.role === "callee")?.userId ?? null;
  const leg = (role: "caller" | "callee", uid: string | null) => {
    const mine = evs.filter((e) => e.source !== "railway" && e.source !== "pion" && (e.role === role || (!!uid && e.userId === uid)));
    const meta = mine.find((e) => e.device) ?? mine[0];
    const states = mine.filter((e) => e.kind === "state").map((e) => ({ from: e.fromState, to: e.toState, reason: e.reason, detail: e.detail, t: e.tCallMs, ts: e.tsClient ?? e.tsServer }));
    const failed = states.find((s) => s.to === "failed");
    const p = pion?.[role];
    return {
      userId: uid, platform: meta?.platform ?? (role === "caller" ? (start?.extra.callerPlatform as string) : (rw.find((e) => e.event === "call_accept")?.extra.calleePlatform as string)) ?? p?.client?.match(/platform=([^:]+)/)?.[1] ?? null,
      device: meta?.device ?? p?.client?.match(/device=([^:]+)/)?.[1] ?? null, os: meta?.os ?? null, appVersion: meta?.appVersion ?? null, engine: meta?.engine ?? null,
      reached: states.at(-1)?.to ?? null, failure: failed ? { tag: failed.reason, detail: failed.detail } : null, states,
      pion: p ? { states: p.states, path: p.path, closed: p.closed } : null,
    };
  };
  const caller = leg("caller", callerId), callee = leg("callee", calleeId);
  const end = rw.find((e) => e.event === "call_end");
  const media = evs.some((e) => e.media === "video") ? "video" : evs.some((e) => e.media === "audio") ? "audio" : null;
  const paths = [caller.pion?.path, callee.pion?.path, ...evs.map((e) => (e.extra.path as string) || null)].filter(Boolean) as string[];
  const path = paths.includes("relay") ? "relay" : paths.includes("direct") ? "direct" : "unknown";
  const tags = [caller.failure?.tag, callee.failure?.tag, ...Object.values(pion ?? {}).flatMap((l) => l.states.filter((s) => s.to === "failed").map((s) => s.reason))].filter(Boolean) as string[];
  return {
    callId, startedAt: start?.tsServer ?? evs[0]?.tsServer ?? null, outcome: (end?.extra.outcome as string) ?? end?.reason ?? null,
    durationSec: (end?.extra.durationSec as number) ?? null, media, path,
    matrix: `${caller.platform ?? "?"}/${caller.device ?? "?"} -> ${callee.platform ?? "?"}/${callee.device ?? "?"} ${media ?? "?"} ${path}`,
    connected: caller.reached === "connected" || callee.reached === "connected" || !!Object.values(pion ?? {}).some((l) => l.states.some((s) => s.to === "connected")),
    failureTags: [...new Set(tags)], caller, callee, events: evs.length,
  };
}

export function matrixRollup(summaries: ReturnType<typeof summarizeCall>[]) {
  const m = new Map<string, { combo: string; calls: number; connected: number; failed: number; tags: Record<string, number> }>();
  for (const s of summaries) {
    const r = m.get(s.matrix) ?? { combo: s.matrix, calls: 0, connected: 0, failed: 0, tags: {} };
    r.calls++; if (s.connected) r.connected++; if (s.failureTags.length) r.failed++;
    for (const t of s.failureTags) r.tags[t] = (r.tags[t] ?? 0) + 1;
    m.set(s.matrix, r);
  }
  return [...m.values()].sort((a, b) => b.calls - a.calls);
}

// ------------------------------------------------------------------ HTTP
type Json = (res: import("node:http").ServerResponse, status: number, body: unknown) => void;
const hits = new Map<string, number[]>();
function allow(k: string, max = 60, windowMs = 60_000) {
  const now = Date.now(); const a = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
  if (a.length >= max) return false; a.push(now); hits.set(k, a);
  if (hits.size > 10_000) hits.clear();
  return true;
}

/** POST /api/call-log  {events:[...], olcallToken?}  (session bearer or olcall token). 200 {ok, stored, dropped, where}. */
export async function handleCallLogIngest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, json: Json,
  readJson: (req: import("node:http").IncomingMessage, limit?: number) => Promise<Record<string, unknown>>,
  authenticate: (bearer: string) => Promise<{ ok: true; userId: string } | { ok: false; reason?: string }>, store: CallLogStore = callLog()) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
  const body = await readJson(req, LIMITS.bodyBytes);
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  let who: { userId: string; callId?: string | null } | null = null;
  if (bearer) { const a = await authenticate(bearer).catch(() => null); if (a && a.ok) who = { userId: a.userId }; }
  if (!who) { const c = verifyOlcallTokenForLog(body.olcallToken); if (c) who = { userId: c.userId, callId: c.callId }; }
  if (!who) return json(res, 401, { ok: false, error: "Not signed in" });
  if (!allow(`ingest:${who.userId}`)) return json(res, 429, { ok: false, error: "Too many requests" });
  const raw = Array.isArray(body.events) ? body.events.slice(0, LIMITS.batch) : [];
  const now = Date.now();
  const evs = raw.map((e) => sanitizeClientEvent(e, who!, now)).filter((e): e is CallLogEvent => !!e);
  const where = await store.add(evs);
  return json(res, 200, { ok: true, stored: evs.length, dropped: raw.length - evs.length, where });
}

export function reviewKeyOk(presented: unknown, env: Record<string, string | undefined> = process.env) {
  const want = (env.CALL_LOG_REVIEW_KEY ?? "").trim();
  if (want.length < 32 || typeof presented !== "string" || !presented) return false;
  const a = createHash("sha256").update(presented).digest(), b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** GET /api/admin/call-log?call=|user=|since=|until=|matrix=1|pion=0 (admin bearer or X-Call-Log-Key). */
export async function handleCallLogReview(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, json: Json, admin: boolean,
  store: CallLogStore = callLog(), pionFetch: typeof fetchPionCrumbs = fetchPionCrumbs) {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
  if (!admin && !reviewKeyOk(req.headers["x-call-log-key"])) return json(res, 403, { ok: false, error: "Admins only" });
  const qs = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const callId = id(qs.get("call")) ?? undefined, userId = id(qs.get("user")) ?? undefined;
  const since = num(qs.get("since")) ?? undefined, until = num(qs.get("until")) ?? undefined;
  if (callId) {
    const evs = await store.query({ callId });
    const p = qs.get("pion") === "0" ? null : await pionFetch(callId);
    const legs = p?.ok ? pionTimeline(p.crumbs) : undefined;
    return json(res, 200, { ok: true, storage: store.kind, summary: summarizeCall(callId, evs, legs), pion: p ? { ok: p.ok, error: p.error ?? null, crumbs: p.crumbs.length, legs } : null, timeline: evs });
  }
  const evs = await store.query({ userId, since: since ?? Date.now() - 7 * 86_400_000, until, limit: 20_000 });
  const ids = [...new Set(evs.map((e) => e.callId))];
  const summaries = ids.map((cid) => summarizeCall(cid, evs)).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return json(res, 200, { ok: true, storage: store.kind, calls: summaries.length, summaries: summaries.slice(0, 500), ...(qs.get("matrix") === "1" ? { matrix: matrixRollup(summaries) } : {}) });
}
