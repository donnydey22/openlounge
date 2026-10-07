// Test harness: local Postgres (never prod), mock Google/Apple (locally generated JWKS + token endpoints),
// and the real HTTP API + WebSocket realtime layer in-process (no Next.js needed).
//
//   TEST_DATABASE_URL (default postgresql://ua@127.0.0.1:55433/ua_test) — the schema is wiped first, so the URL
//   must point at a throwaway database. Refuses anything that isn't localhost.

import http, { type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import pg from "pg";
import WebSocket from "ws";

export const TEST_DB = process.env.TEST_DATABASE_URL || "postgresql://ua@127.0.0.1:55433/ua_test";

export function assertLocalDb(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error(`refusing to run tests against non-local database ${host}`);
}

export async function wipeDb(url = TEST_DB) {
  assertLocalDb(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
}

export async function sql<T extends pg.QueryResultRow = Record<string, unknown>>(q: string, params: unknown[] = [], url = TEST_DB): Promise<T[]> {
  assertLocalDb(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(q, params)).rows;
  } finally {
    await c.end();
  }
}

// ---------- mock identity providers ----------

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function makeRsaSigner(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "RS256", use: "sig" };
  const sign = (claims: Record<string, unknown>, opts: { kid?: string; key?: KeyObject } = {}) => {
    const input = `${b64u(JSON.stringify({ alg: "RS256", kid: opts.kid ?? kid, typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${b64u(cryptoSign("RSA-SHA256", Buffer.from(input), opts.key ?? privateKey))}`;
  };
  return { jwk, sign, privateKey };
}

export function makeEcSigner(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "ES256", use: "sig" };
  const sign = (claims: Record<string, unknown>) => {
    const input = `${b64u(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${b64u(cryptoSign("SHA256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
  };
  return { jwk, sign, privateKey, publicKey };
}

export interface MockProviders {
  url: string;
  google: ReturnType<typeof makeRsaSigner>;
  apple: ReturnType<typeof makeRsaSigner>;
  /** register what the provider will say for an authorization code */
  authorize(provider: "google" | "apple", code: string, claims: Record<string, unknown>, expect: { challenge?: string }): void;
  tokenRequests: Record<string, string>[];
  close(): Promise<void>;
}

export async function startMockProviders(cfg: { googleClientId: string; googleSecret: string; appleServicesId: string; appleTeamId: string; appleKeyId: string; applePublicKey: KeyObject }): Promise<MockProviders> {
  const google = makeRsaSigner("g-kid-1");
  const apple = makeRsaSigner("a-kid-1");
  const codes = new Map<string, { provider: string; claims: Record<string, unknown>; challenge?: string }>();
  const tokenRequests: Record<string, string>[] = [];
  const server = http.createServer(async (req, res) => {
    const send = (s: number, b: unknown) => (res.writeHead(s, { "Content-Type": "application/json" }), res.end(JSON.stringify(b)));
    if (req.url === "/google/jwks") return send(200, { keys: [google.jwk] });
    if (req.url === "/apple/jwks") return send(200, { keys: [apple.jwk] });
    if (req.url === "/google/token" || req.url === "/apple/token") {
      let raw = "";
      for await (const c of req) raw += c;
      const f = Object.fromEntries(new URLSearchParams(raw));
      tokenRequests.push(f);
      const entry = codes.get(f.code);
      codes.delete(f.code);
      const provider = req.url.startsWith("/google") ? "google" : "apple";
      if (!entry || entry.provider !== provider) return send(400, { error: "invalid_grant" });
      if (provider === "google") {
        if (f.client_id !== cfg.googleClientId || f.client_secret !== cfg.googleSecret) return send(401, { error: "invalid_client" });
        if (!f.code_verifier || createHash("sha256").update(f.code_verifier).digest("base64url") !== entry.challenge) return send(400, { error: "invalid_grant", why: "pkce" });
        return send(200, { access_token: "x", id_token: google.sign(entry.claims), token_type: "Bearer" });
      }
      // Apple: client_secret must be an ES256 JWT from our team/key for this Services ID
      const [h, p, s] = (f.client_secret ?? "").split(".");
      const header = JSON.parse(Buffer.from(h ?? "", "base64url").toString() || "{}");
      const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString() || "{}");
      const ok =
        !!s &&
        cryptoVerify("SHA256", Buffer.from(`${h}.${p}`), { key: cfg.applePublicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")) &&
        header.alg === "ES256" && header.kid === cfg.appleKeyId && payload.iss === cfg.appleTeamId && payload.sub === cfg.appleServicesId &&
        payload.aud === "https://appleid.apple.com" && f.client_id === cfg.appleServicesId;
      if (!ok) return send(401, { error: "invalid_client" });
      return send(200, { access_token: "x", id_token: apple.sign(entry.claims), token_type: "Bearer" });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    google,
    apple,
    tokenRequests,
    authorize: (provider, code, claims, expect) => codes.set(code, { provider, claims, challenge: expect.challenge }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---------- app under test ----------

export interface App {
  base: string;
  wsUrl: string;
  close(): Promise<void>;
}

export const APPLE_TEAM = "9A6NA2ZAFH";

/** Configure env (fake provider credentials, local DB) BEFORE importing server modules. */
export function setTestEnv(opts: { providers: boolean; dbUrl?: string }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ol-auth-test-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: opts.dbUrl ?? TEST_DB,
    DATA_DIR: dataDir,
    SKIP_JSON_IMPORT: "1",
    AUTH_SECRET: "test-secret-" + randomBytes(8).toString("hex"),
  });
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APPLE_TEAM_ID", "APPLE_SERVICES_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY", "SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASS", "AUTH_EMAIL_DEV"]) delete process.env[k];
  if (!opts.providers) return null;
  const appleKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    APPLE_TEAM_ID: APPLE_TEAM,
    APPLE_SERVICES_ID: "app.openlounge.web.test",
    APPLE_KEY_ID: "TESTKEY123",
    // as pasted into Railway: a single line with literal \n escapes
    APPLE_PRIVATE_KEY: (appleKey.privateKey.export({ format: "pem", type: "pkcs8" }) as string).replace(/\n/g, "\\n"),
    AUTH_EMAIL_DEV: "1",
  });
  return { applePublicKey: createPublicKey(appleKey.publicKey.export({ format: "pem", type: "spki" }) as string) };
}

export async function startApp(): Promise<App> {
  const { store } = await import("../../server/store");
  const { api, isApiRequest } = await import("../../server/http");
  const { WsHub } = await import("../../server/ws");
  const { registerRealtime } = await import("../../server/realtime");
  const { originAllowed } = await import("../../server/auth");
  await store.init();
  const server = http.createServer((req, res) => {
    if (isApiRequest(req.url ?? "")) return void api(req, res).catch((e) => (console.error(e), res.writeHead(503).end()));
    res.writeHead(404).end();
  });
  registerRealtime(new WsHub(server, "/ws", (req: IncomingMessage) => originAllowed(req.headers.origin, req.headers.host)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  process.env.AUTH_PUBLIC_URL = `http://127.0.0.1:${port}`;
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: async () => {
      await store.flush();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(null)));
    },
  };
}

// ---------- clients ----------

export async function api(base: string, p: string, body?: unknown, opts: { token?: string; headers?: Record<string, string>; method?: string } = {}) {
  const res = await fetch(base + p, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, data: data ?? {}, headers: res.headers };
}

export function wsClient(url: string) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map<number, (d: any) => void>();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
  });
  const open = new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  return {
    open,
    req: (ev: string, data: unknown = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ t: "req", id, ev, data }));
        setTimeout(() => pending.has(id) && reject(new Error(`timeout ${ev}`)), 8000);
      }),
    close: () => ws.close(),
    ws,
  };
}

/** Phone OTP signup or login over the WebSocket, exactly like the app (demo provider: code 000000). */
export async function phoneLogin(wsUrl: string, phone: string, profile?: { firstName: string; username: string }) {
  const c = wsClient(wsUrl);
  await c.open;
  const sent = await c.req("auth:requestCode", { phone });
  if (!sent.ok) throw new Error("requestCode: " + JSON.stringify(sent));
  const v = await c.req("auth:verifyCode", { phone, code: "000000" });
  if (!v.ok) throw new Error("verifyCode: " + JSON.stringify(v));
  if (v.status === "existing") return { client: c, res: v, created: false };
  if (!profile) throw new Error("phone not registered");
  const r = await c.req("auth:register", { ticket: v.ticket, firstName: profile.firstName, lastName: "", username: profile.username, bio: "", color: "#3B82F6", interests: [] });
  if (!r.ok) throw new Error("register: " + JSON.stringify(r));
  return { client: c, res: r, created: true };
}

/** Finish onboarding for a signup ticket from email / Google / Apple (same ws auth:register as phone). */
export async function registerTicket(wsUrl: string, ticket: string, profile: { firstName: string; username: string }) {
  const c = wsClient(wsUrl);
  await c.open;
  const r = await c.req("auth:register", { ticket, firstName: profile.firstName, lastName: "", username: profile.username, bio: "", color: "#22C55E", interests: [] });
  return { client: c, res: r };
}

const cookieOf = (setCookie: string | null) => (setCookie ?? "").split(";")[0];

/**
 * Full browser-style OAuth round trip against the app + mock provider:
 * /auth/{p}/start → (provider) → /auth/{p}/callback → /auth/complete?code=… → POST /auth/exchange.
 */
export async function oauthRoundTrip(
  app: App,
  mock: MockProviders,
  provider: "google" | "apple",
  claims: Record<string, unknown>,
  opts: { query?: string; appleUser?: unknown; codeVerifier?: string; tamperState?: boolean; dropCookie?: boolean; nonceOverride?: string; audOverride?: string } = {},
) {
  const start = await fetch(`${app.base}/auth/${provider}/start${opts.query ? `?${opts.query}` : ""}`, { redirect: "manual" });
  const loc = start.headers.get("location") ?? "";
  if (!loc.startsWith(mock.url)) return { stage: "start", location: loc, status: start.status } as const;
  const authz = new URL(loc);
  const cookie = cookieOf(start.headers.get("set-cookie"));
  const state = authz.searchParams.get("state")!;
  const nonce = authz.searchParams.get("nonce")!;
  const code = "authcode-" + randomBytes(6).toString("hex");
  const aud = opts.audOverride ?? (provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.APPLE_SERVICES_ID);
  const iss = provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com";
  const now = Math.floor(Date.now() / 1000);
  mock.authorize(provider, code, { iss, aud, iat: now, exp: now + 600, nonce: opts.nonceOverride ?? nonce, ...claims }, { challenge: authz.searchParams.get("code_challenge") ?? undefined });
  const headers: Record<string, string> = opts.dropCookie ? {} : { Cookie: cookie };
  let cb: Response;
  const st = opts.tamperState ? state + "x" : state;
  if (provider === "google") {
    cb = await fetch(`${app.base}/auth/google/callback?${new URLSearchParams({ code, state: st })}`, { headers, redirect: "manual" });
  } else {
    const form = new URLSearchParams({ code, state: st, ...(opts.appleUser ? { user: JSON.stringify(opts.appleUser) } : {}) });
    cb = await fetch(`${app.base}/auth/apple/callback`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://appleid.apple.com" },
      body: form,
      redirect: "manual",
    });
  }
  const done = cb.headers.get("location") ?? "";
  const doneUrl = new URL(done, app.base);
  const oneTime = doneUrl.searchParams.get("code");
  if (!oneTime) return { stage: "callback", location: done, status: cb.status, error: doneUrl.searchParams.get("error"), authz, cookieHeader: start.headers.get("set-cookie") } as const;
  const ex = await api(app.base, "/auth/exchange", { code: oneTime, ...(opts.codeVerifier ? { codeVerifier: opts.codeVerifier } : {}) });
  return { stage: "exchange", location: done, status: cb.status, exchange: ex, oneTime, authz, cookieHeader: start.headers.get("set-cookie") } as const;
}
