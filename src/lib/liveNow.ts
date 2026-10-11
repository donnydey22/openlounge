// "Live now" inbox on the client: one shared list per socket (bell badge + /live page), kept current over the
// WebSocket — notify:inbox (new entry), notify:inboxEnded (room ended → entry gone), notify:inboxRead (another tab /
// device read it). Server side: server/push/liveInbox.ts.
"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { RealtimeClient } from "@/lib/realtime";
import type { LiveNoticeEntry } from "@/lib/types";

type State = { entries: LiveNoticeEntry[]; loaded: boolean };
let state: State = { entries: [], loaded: false };
let bound: RealtimeClient | null = null;
const subs = new Set<() => void>();
const set = (next: State) => {
  state = next;
  for (const f of subs) f();
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const EMPTY: State = { entries: [], loaded: false };

function load(s: RealtimeClient) {
  s.request<{ ok: boolean; entries?: LiveNoticeEntry[] }>("notify:inbox", {})
    .then((res) => {
      if (bound === s && res?.ok) set({ entries: res.entries ?? [], loaded: true });
    })
    .catch(() => {}); // offline: the next (re)connect loads it
}

function bind(s: RealtimeClient) {
  if (bound === s) return;
  bound = s;
  set(EMPTY);
  s.on("notify:inbox", ({ entry }: { entry: LiveNoticeEntry }) => {
    if (bound !== s || !entry?.room) return;
    set({ ...state, entries: [entry, ...state.entries.filter((e) => e.roomId !== entry.roomId)] });
  });
  s.on("notify:inboxEnded", ({ roomId }: { roomId: string }) => {
    if (bound === s) set({ ...state, entries: state.entries.filter((e) => e.roomId !== roomId) });
  });
  s.on("notify:inboxRead", ({ roomIds }: { roomIds: string[] | null }) => {
    if (bound !== s) return;
    const at = Date.now();
    set({ ...state, entries: state.entries.map((e) => (e.readAt === null && (!roomIds || roomIds.includes(e.roomId)) ? { ...e, readAt: at } : e)) });
  });
}

/** `ready`: signed in and connected — (re)loads then, so a reconnect catches up on what changed while away */
export function useLiveNow(socket: RealtimeClient | null, ready: boolean) {
  useEffect(() => {
    if (!socket) return;
    bind(socket);
    if (ready) load(socket);
  }, [socket, ready]);
  const snap = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  const unread = snap.entries.reduce((n, e) => n + (e.readAt === null ? 1 : 0), 0);
  return { ...snap, unread };
}

/** mark entries read (all when roomIds is omitted); optimistic, server persists + tells other tabs */
export function markLiveRead(socket: RealtimeClient | null, roomIds?: string[]) {
  if (!socket) return;
  const at = Date.now();
  set({ ...state, entries: state.entries.map((e) => (e.readAt === null && (!roomIds || roomIds.includes(e.roomId)) ? { ...e, readAt: at } : e)) });
  socket.request("notify:inboxRead", roomIds ? { roomIds } : {}).catch(() => {});
}

/** "12m", "1h 5m", "just now" — how long the room has been live */
export function liveFor(startedAt: number, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
