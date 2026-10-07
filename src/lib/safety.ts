"use client";
// UGC safety client state (App Store 1.2): who I blocked + whose content I must hide (blocked either way).
// Module-level store + useSyncExternalStore so any component can read it without touching AppProvider.
import { useEffect, useSyncExternalStore } from "react";
import { authFetch } from "./auth";
import type { PublicUser } from "./types";

export { SUPPORT_EMAIL, SUPPORT_MAILTO } from "./support";

export const REPORT_REASONS: { id: string; label: string }[] = [
  { id: "spam", label: "Spam or scam" },
  { id: "harassment", label: "Harassment or bullying" },
  { id: "hate", label: "Hate speech or slurs" },
  { id: "sexual", label: "Sexual or explicit content" },
  { id: "violence", label: "Violence or threats" },
  { id: "self_harm", label: "Self-harm or suicide" },
  { id: "impersonation", label: "Impersonation" },
  { id: "illegal", label: "Illegal activity" },
  { id: "other", label: "Something else" },
];

export type ReportTarget = { type: "user" | "room" | "message" | "dm"; id: string; roomId?: string; label?: string };

type State = { loaded: boolean; owner: string | null; blocked: PublicUser[]; hidden: Set<string>; admin?: boolean };
let state: State = { loaded: false, owner: null, blocked: [], hidden: new Set() };
const subs = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  subs.forEach((f) => f());
}

function apply(data: { blocked?: PublicUser[]; hidden?: string[]; admin?: boolean }) {
  set({ loaded: true, blocked: data.blocked ?? [], hidden: new Set(data.hidden ?? []), ...(data.admin !== undefined ? { admin: data.admin } : {}) });
}

export function refreshBlocks(): Promise<void> {
  inflight ??= authFetch("/api/me/blocks")
    .then(async (r) => {
      if (r.ok) apply(await r.json());
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function errorOf(r: Response) {
  const d = await r.json().catch(() => null);
  return new Error(d?.error || "Something went wrong — try again.");
}

export async function setBlocked(userId: string, block: boolean) {
  const r = await authFetch("/api/me/blocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, block }) });
  if (!r.ok) throw await errorOf(r);
  apply(await r.json());
}

export async function sendReport(target: ReportTarget, reason: string, note: string) {
  const r = await authFetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetType: target.type, targetId: target.id, roomId: target.roomId, reason, note }),
  });
  if (!r.ok) throw await errorOf(r);
}

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/** { blocked, hidden, isBlocked(id), isHidden(id) } — loads once per signed-in user on first use (pass me?.id). */
export function useSafety(userId: string | null | undefined) {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (!userId) return;
    if (state.owner !== userId) {
      set({ loaded: false, owner: userId, blocked: [], hidden: new Set() });
      void refreshBlocks();
    } else if (!state.loaded) void refreshBlocks();
  }, [userId]);
  return {
    loaded: s.loaded,
    blocked: s.blocked,
    hidden: s.hidden,
    admin: !!s.admin,
    isBlocked: (id: string) => s.blocked.some((u) => u.id === id),
    isHidden: (id: string) => s.hidden.has(id),
  };
}

/** forget on sign-out */
export function resetSafety() {
  set({ loaded: false, owner: null, blocked: [], hidden: new Set() });
}
