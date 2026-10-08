// Account-linking rules shared by Google, Apple and email sign-in (unit-tested in tests/unified-auth).
//
//   1. (provider, subject) already known            → that account.
//   2. else the provider vouches for the email (VERIFIED) and exactly one account owns a VERIFIED identity with that
//      email (any provider: email / google / apple)  → attach this identity to that account and sign it in.
//   3. else                                          → brand-new account (existing onboarding: name → username → …).
// Unverified emails never link anything. Linking from Settings ("add Google") attaches to the signed-in account and
// refuses identities that already belong to someone else.

import type { IdentityProvider } from "../persistence";
import type { Store } from "../store";
import { normalizeEmail } from "../store";

export interface ExternalIdentity {
  provider: IdentityProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

export type Resolution =
  | { kind: "existing"; userId: string; via: "identity" | "verified_email" }
  | { kind: "new"; identity: { provider: IdentityProvider; subject: string; email: string | null; verified: boolean } };

export function resolveSignIn(store: Store, ext: ExternalIdentity): Resolution {
  const email = normalizeEmail(ext.email);
  const known = store.findIdentity(ext.provider, ext.subject);
  if (known && store.users.has(known.userId)) {
    // keep the email current (Apple/Google users can change it); never downgrade verification
    if (email && (known.email !== email || (ext.emailVerified && !known.verified))) store.addIdentity(known.userId, { provider: ext.provider, subject: ext.subject, email, verified: ext.emailVerified });
    store.touchIdentity(ext.provider, ext.subject);
    return { kind: "existing", userId: known.userId, via: "identity" };
  }
  if (email && ext.emailVerified) {
    const owner = store.userByVerifiedEmail(email);
    if (owner) {
      const r = store.addIdentity(owner, { provider: ext.provider, subject: ext.subject, email, verified: true });
      if (r.ok) {
        store.touchIdentity(ext.provider, ext.subject);
        return { kind: "existing", userId: owner, via: "verified_email" };
      }
    }
  }
  return { kind: "new", identity: { provider: ext.provider, subject: ext.subject, email, verified: !!email && ext.emailVerified } };
}

export type LinkResult = { ok: true; already: boolean } | { ok: false; code: "taken" | "has_phone" | "no_user"; error: string };

/** Settings → "add a sign-in method" for an already signed-in user. */
export function linkToUser(store: Store, userId: string, ext: ExternalIdentity): LinkResult {
  const known = store.findIdentity(ext.provider, ext.subject);
  if (known && known.userId === userId) return { ok: true, already: true };
  if (known) return { ok: false, code: "taken", error: "That account is already linked to a different Open Lounge account." };
  const r = store.addIdentity(userId, { provider: ext.provider, subject: ext.subject, email: normalizeEmail(ext.email), verified: !!ext.email && ext.emailVerified });
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  return { ok: true, already: false };
}

/** Public view of a user's sign-in methods (Settings). Subjects are hashed into an opaque id. */
export function describeIdentities(store: Store, userId: string) {
  const mask = (e: string | null) => {
    if (!e) return null;
    const [l, d] = e.split("@");
    return d ? `${l.slice(0, 2)}${l.length > 2 ? "•••" : ""}@${d}` : e;
  };
  return store.identitiesOf(userId).map((i) => ({
    id: `${i.provider}:${Buffer.from(i.subject).toString("base64url")}`,
    provider: i.provider,
    label:
      i.provider === "phone"
        ? `${i.subject.slice(0, i.subject.length - 7)} ••• ${i.subject.slice(-4)}`
        : i.provider === "email"
          ? i.subject
          : (mask(i.email) ?? (i.provider === "apple" ? "Apple ID" : "Google account")),
    privateRelay: i.provider === "apple" && !!i.email?.endsWith("@privaterelay.appleid.com"),
    verified: i.verified,
    createdAt: i.createdAt,
  }));
}

export function parseIdentityId(id: unknown): { provider: IdentityProvider; subject: string } | null {
  if (typeof id !== "string") return null;
  const m = /^(phone|email|google|apple):([\w-]+)$/.exec(id);
  if (!m) return null;
  return { provider: m[1] as IdentityProvider, subject: Buffer.from(m[2], "base64url").toString("utf8") };
}

// ---------- linking a Google/Apple/email identity to an existing (phone) account ----------
//
// Used by (a) the sign-in "Already have an Open Lounge account?" step, after the person re-proves their phone with
// Firebase, and (b) Settings → add Google/Apple. Both prove control of BOTH sides (provider sign-in + phone/session),
// so a `taken` identity may be moved off a *disposable* duplicate account — never off an account with real data.

/** A duplicate is only disposable while it is this young. */
export const DUPLICATE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface AccountDataCounts {
  dms: number;
  roomsHosted: number;
  roomsJoined: number;
  following: number;
  followers: number;
}

export function accountDataCounts(store: Store, userId: string): AccountDataCounts {
  let dms = 0;
  for (const list of store.dms.values()) for (const m of list) if (m.fromId === userId || m.toId === userId) dms++;
  let roomsHosted = 0;
  let roomsJoined = 0;
  for (const r of store.rooms.values()) {
    if (r.hostId === userId) roomsHosted++;
    else if (r.participants.has(userId)) roomsJoined++;
  }
  const following = store.follows.get(userId)?.size ?? 0;
  let followers = 0;
  for (const [f, set] of store.follows) if (f !== userId && set.has(userId)) followers++;
  return { dms, roomsHosted, roomsJoined, following, followers };
}

/**
 * Can `ownerId` be deleted so its only identity (provider, subject) moves elsewhere? Only when it is an empty,
 * recently created account whose ONLY sign-in method is that identity (no phone, no second method).
 */
export function disposableDuplicate(store: Store, ownerId: string, ext: { provider: IdentityProvider; subject: string }, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const u = store.users.get(ownerId);
  if (!u || u.isBot) return { ok: false, reason: "no_user" };
  if (u.phone) return { ok: false, reason: "has_phone" };
  const ids = store.identitiesOf(ownerId);
  if (ids.length !== 1 || ids[0].provider !== ext.provider || ids[0].subject !== ext.subject) return { ok: false, reason: "other_methods" };
  if (now - u.createdAt > DUPLICATE_MAX_AGE_MS) return { ok: false, reason: "too_old" };
  const c = accountDataCounts(store, ownerId);
  if (c.dms || c.roomsHosted || c.roomsJoined || c.following || c.followers) return { ok: false, reason: "has_data" };
  return { ok: true };
}

export type LinkExistingResult =
  | { ok: true; already: boolean; removedDuplicate: string | null }
  | { ok: false; code: "taken" | "has_phone" | "no_user" | "no_phone"; error: string };

export const TAKEN_WITH_DATA_ERROR =
  "That sign-in is already used by another Open Lounge account that has its own messages, rooms or follows, so it can't be moved automatically. Sign in with it and delete that account in Settings first, or contact support.";

/**
 * Attach `ext` to `userId` (an account with a verified phone). If `ext` already belongs to a disposable duplicate
 * (see above), that duplicate is deleted and the identity moves here. Anything else that's taken is refused.
 * The caller removes the duplicate's push data (device tokens) using `removedDuplicate`.
 */
export function linkToPhoneAccount(store: Store, userId: string, ext: ExternalIdentity): LinkExistingResult {
  const u = store.users.get(userId);
  if (!u || u.isBot) return { ok: false, code: "no_user", error: "Account not found" };
  if (!store.identitiesOf(userId).some((i) => i.provider === "phone" && i.verified)) return { ok: false, code: "no_phone", error: "Verify a phone number on this account first." };
  const known = store.findIdentity(ext.provider, ext.subject);
  let removedDuplicate: string | null = null;
  if (known && known.userId === userId) return { ok: true, already: true, removedDuplicate };
  if (known && store.users.has(known.userId)) {
    if (!disposableDuplicate(store, known.userId, ext).ok) return { ok: false, code: "taken", error: TAKEN_WITH_DATA_ERROR };
    const d = store.deleteAccount(known.userId, { tombstone: false }); // empty duplicate: hard delete, no "Deleted Account" tombstone
    if (!d.ok) return { ok: false, code: "taken", error: TAKEN_WITH_DATA_ERROR };
    removedDuplicate = known.userId;
    console.log(`[auth] moved ${ext.provider} identity from empty duplicate ${known.userId} to ${userId}`);
  }
  const r = store.addIdentity(userId, { provider: ext.provider, subject: ext.subject, email: normalizeEmail(ext.email), verified: !!ext.email && ext.emailVerified });
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  store.touchIdentity(ext.provider, ext.subject);
  return { ok: true, already: false, removedDuplicate };
}
