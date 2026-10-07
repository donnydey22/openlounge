// Which sign-in methods are switched on (env-driven feature flags) + Google / Apple OAuth endpoints.
// A provider is "on" only when all of its env vars are present, so deploying without credentials changes nothing.

import type { KeyObject } from "node:crypto";
import { parseP8, signEs256 } from "./jwt";

const env = (k: string) => process.env[k]?.trim() || "";
const isProd = () => process.env.NODE_ENV === "production";

export interface Endpoints {
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuers: string[];
}

const DEFAULTS: Record<"google" | "apple", Endpoints> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
  },
  apple: {
    authUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    jwksUrl: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
  },
};
let overrides: Partial<Record<"google" | "apple", Endpoints>> = {};

/** Tests only: point a provider at a local mock (JWKS + token endpoint). Ignored in production. */
export function __setProviderEndpoints(o: Partial<Record<"google" | "apple", Endpoints>>) {
  if (isProd()) return;
  overrides = o;
}
export const endpoints = (p: "google" | "apple"): Endpoints => overrides[p] ?? DEFAULTS[p];

// ---------- flags ----------

export const googleConfig = () => {
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

let appleKeyCache: { raw: string; key: KeyObject | null } | null = null;
export const appleConfig = () => {
  const teamId = env("APPLE_TEAM_ID");
  const servicesId = env("APPLE_SERVICES_ID");
  const keyId = env("APPLE_KEY_ID");
  const raw = process.env.APPLE_PRIVATE_KEY ?? "";
  if (!teamId || !servicesId || !keyId || !raw.trim()) return null;
  if (appleKeyCache?.raw !== raw) {
    let key: KeyObject | null = null;
    try {
      key = parseP8(raw);
    } catch {
      console.warn("[auth] APPLE_PRIVATE_KEY could not be parsed (expected the .p8 PEM) — Sign in with Apple stays off");
    }
    appleKeyCache = { raw, key };
  }
  return appleKeyCache.key ? { teamId, servicesId, keyId, key: appleKeyCache.key } : null;
};

export const smtpConfigured = () => !!(env("SMTP_HOST") && env("SMTP_FROM"));
/** Email sign-in needs a way to deliver verification/reset links: SMTP, or (dev only) AUTH_EMAIL_DEV=1 = log links. */
export const emailEnabled = () => smtpConfigured() || (!isProd() && /^(1|true|yes)$/i.test(env("AUTH_EMAIL_DEV")));

export function providerFlags() {
  return { phone: true, email: emailEnabled(), google: !!googleConfig(), apple: !!appleConfig() };
}

/** Log once at boot which methods are on (names only — never values). */
export function logProviderStatus() {
  const f = providerFlags();
  const on = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
  console.log(`[auth] sign-in methods: ${on.join(", ")}${smtpConfigured() ? "" : f.email ? " (email links are logged — AUTH_EMAIL_DEV)" : ""}`);
}

// ---------- public URL / redirect URIs ----------

/**
 * Canonical public origin used for OAuth redirect URIs and email links. AUTH_PUBLIC_URL wins; production defaults
 * to https://openlounge.app; dev uses the request's Host (http://localhost:3000).
 */
export function publicBaseUrl(host?: string): string {
  const configured = env("AUTH_PUBLIC_URL").replace(/\/+$/, "");
  if (configured) return configured;
  if (isProd()) return "https://openlounge.app";
  return `http://${host || "localhost:3000"}`;
}

export const redirectUri = (provider: "google" | "apple", host?: string) => `${publicBaseUrl(host)}/auth/${provider}/callback`;

// ---------- Apple client secret (ES256 JWT, cached ~1 h, valid 2 h) ----------

let appleSecret: { jwt: string; exp: number; keyId: string } | null = null;
export function appleClientSecret(): string {
  const cfg = appleConfig();
  if (!cfg) throw new Error("apple not configured");
  const now = Math.floor(Date.now() / 1000);
  if (appleSecret && appleSecret.keyId === cfg.keyId && appleSecret.exp - now > 3600) return appleSecret.jwt;
  const exp = now + 2 * 3600;
  const jwt = signEs256({ kid: cfg.keyId, typ: "JWT" }, { iss: cfg.teamId, iat: now, exp, aud: "https://appleid.apple.com", sub: cfg.servicesId }, cfg.key);
  appleSecret = { jwt, exp, keyId: cfg.keyId };
  return jwt;
}
