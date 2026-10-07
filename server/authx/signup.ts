// Signup tickets: "this person proved who they are (phone OTP, verified email link, Google, Apple) but has no
// account yet". The client carries the ticket through the existing onboarding screens (name → username → photo →
// bio) and redeems it with ws auth:register. Memory only, 30 minutes — same as the phone flow always was.

import { randomBytes } from "node:crypto";
import type { IdentityProvider } from "../persistence";

export type SignupTicket =
  | { kind: "phone"; phone: string; expiresAt: number }
  | {
      kind: "identity";
      identity: { provider: IdentityProvider; subject: string; email: string | null; verified: boolean };
      passwordHash?: string | null;
      expiresAt: number;
    };

const TTL_MS = 30 * 60_000;
const tickets = new Map<string, SignupTicket>();

type NewTicket = { kind: "phone"; phone: string } | Omit<Extract<SignupTicket, { kind: "identity" }>, "expiresAt">;

export function issueTicket(data: NewTicket): string {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expiresAt < now) tickets.delete(k);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { ...data, expiresAt: now + TTL_MS } as SignupTicket);
  return ticket;
}

export function getTicket(ticket: unknown): SignupTicket | null {
  if (typeof ticket !== "string") return null;
  const t = tickets.get(ticket);
  if (!t || t.expiresAt < Date.now()) return null;
  return t;
}

export function dropTicket(ticket: string) {
  tickets.delete(ticket);
}
