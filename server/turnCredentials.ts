// Server-only coturn REST credentials for 1:1 calls. The static secret never leaves this module:
// clients receive only a short-lived username and its HMAC-SHA1 credential.
import { createHmac } from "node:crypto";
import type { TurnIceServer } from "../src/lib/types";

export const TURN_URLS = [
  "turn:turn.openlounge.app:3478?transport=udp",
  "turn:turn.openlounge.app:3478?transport=tcp",
  "turns:turn.openlounge.app:443?transport=tcp",
] as const;

/**
 * Default coturn REST credential lifetime: 6 hours. coturn re-checks the username's expiry on every allocation
 * Refresh (~every 10 min), so a credential shorter than the longest call would drop a relayed call mid-way; rejoins
 * also fetch a fresh credential via call:get. Override with TURN_CREDENTIAL_TTL_S (clamped to 10 min .. 24 h).
 */
export const TURN_CREDENTIAL_TTL_S = 6 * 60 * 60;
export const TURN_CREDENTIAL_TTL_MIN_S = 10 * 60;
export const TURN_CREDENTIAL_TTL_MAX_S = 24 * 60 * 60;

export function turnCredentialTtl(raw: string | undefined = process.env.TURN_CREDENTIAL_TTL_S): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return TURN_CREDENTIAL_TTL_S;
  return Math.min(TURN_CREDENTIAL_TTL_MAX_S, Math.max(TURN_CREDENTIAL_TTL_MIN_S, Math.floor(n)));
}

type MintOptions = {
  secret?: string | null;
  ttlS?: number;
  now?: () => number;
};

/**
 * Create a coturn use-auth-secret credential for one authenticated call participant.
 *
 * The username follows coturn's REST form `<unix-expiry>:<opaque-id>`. Its opaque suffix is
 * HMAC-derived from the call and user IDs, so those internal identifiers are never sent to coturn
 * or exposed to the other endpoint. Coturn validates `credential = base64(HMAC-SHA1(secret, username))`.
 * Returning null keeps the established explicit-empty-ICE/TCP path intact when TURN_STATIC_SECRET is unset.
 */
export function mintTurnIceServers(callId: string, userId: string, opts: MintOptions = {}): TurnIceServer[] | null {
  const secret = (opts.secret ?? process.env.TURN_STATIC_SECRET ?? "").trim();
  if (!secret || !callId || !userId) return null;

  const expiresAt = Math.floor((opts.now?.() ?? Date.now()) / 1000) + (opts.ttlS ?? turnCredentialTtl());
  const opaqueId = createHmac("sha256", secret).update(`${callId}\u0000${userId}`).digest("base64url").slice(0, 32);
  const username = `${expiresAt}:call-${opaqueId}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [{ urls: [...TURN_URLS], username, credential, credentialType: "password" }];
}
