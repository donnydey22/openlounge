"use client";

// Live state for in-chat room cards (invite cards, drop-in cards, pasted room links).
// One shared cache for the whole app: a card renders instantly from whatever is known (optimistic), the server
// fills in / refreshes it through one batched "room:cards" request, and "room:card" pushes over the existing
// WebSocket keep it current (listeners, speaker faces, Ended). Re-synced after every reconnect.

import { useEffect, useSyncExternalStore } from "react";
import type { RoomCard } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";

type Entry = { card: RoomCard | null; at: number };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let bound: RealtimeClient | null = null;
let pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let audioOrigin: string | null = null;

const notify = () => {
  version++;
  for (const l of listeners) l();
};

/** Seed / replace a card (from an ack: room:inviteDm, dropin:start) so the UI never waits for a round trip. */
export function primeRoomCard(card: RoomCard | null | undefined) {
  if (!card) return;
  cache.set(card.roomId, { card, at: Date.now() });
  notify();
}

export function getRoomCard(roomId: string) {
  return cache.get(roomId)?.card ?? null;
}

/** DNS + TLS warm-up for the LiveKit server while a joinable card is on screen. */
export function preconnectAudio() {
  if (!audioOrigin || typeof document === "undefined") return;
  let href: string;
  try {
    const u = new URL(audioOrigin.replace(/^ws/, "http"));
    href = u.origin;
  } catch {
    return;
  }
  if (document.head.querySelector(`link[data-lk-preconnect="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "preconnect";
  l.href = href;
  l.crossOrigin = "anonymous";
  l.dataset.lkPreconnect = href;
  document.head.appendChild(l);
}

function flush() {
  flushTimer = null;
  const s = bound;
  if (!s || !pending.size) return;
  const ids = [...pending].slice(0, 30);
  for (const id of ids) pending.delete(id);
  if (pending.size) flushTimer = setTimeout(flush, 0);
  s.request<{ ok: boolean; cards?: RoomCard[]; audioUrl?: string | null }>("room:cards", { roomIds: ids }, 8000)
    .then((r) => {
      if (r?.audioUrl) audioOrigin = r.audioUrl;
      for (const c of r?.cards ?? []) cache.set(c.roomId, { card: c, at: Date.now() });
      notify();
    })
    .catch(() => {
      for (const id of ids) if (!cache.get(id)?.card) cache.delete(id); // retried on next mount / reconnect
    });
}

function want(ids: string[]) {
  let any = false;
  for (const id of ids) {
    if (cache.has(id)) continue;
    cache.set(id, { card: null, at: 0 });
    pending.add(id);
    any = true;
  }
  if (any && !flushTimer) flushTimer = setTimeout(flush, 0); // batch every card mounted in the same frame
}

function bind(socket: RealtimeClient) {
  if (bound === socket) return;
  bound = socket;
  socket.on("room:card", (c: RoomCard) => {
    if (!c?.roomId) return;
    cache.set(c.roomId, { card: c, at: Date.now() });
    notify();
  });
  // missed pushes while disconnected: refresh everything that was still live
  socket.on("connect", () => {
    setTimeout(() => {
      for (const [id, e] of cache) if (!e.card?.ended) pending.add(id);
      if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 0);
    }, 400); // after session:resume
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => version;

/** Live cards for these room ids (null = not loaded yet → render optimistically). */
export function useRoomCards(socket: RealtimeClient | null, connected: boolean, roomIds: string[]): Map<string, RoomCard | null> {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const key = roomIds.join(",");
  useEffect(() => {
    if (!socket) return;
    bind(socket);
    if (connected && key) want(key.split(","));
  }, [socket, connected, key]);
  const out = new Map<string, RoomCard | null>();
  for (const id of roomIds) out.set(id, cache.get(id)?.card ?? null);
  return out;
}
