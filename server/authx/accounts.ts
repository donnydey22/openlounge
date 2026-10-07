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
