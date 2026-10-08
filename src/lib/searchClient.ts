"use client";

// Client side of /hx/* search: tiny TTL cache + debounced hooks. All privacy scoping happens on the server.
import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth";

export type HxMessage = {
  id: string;
  href: string;
  chat: { id: string; kind: "dm" | "group"; title: string; color: string; photoUrl: string | null };
  from: { id: string; name: string; me: boolean };
  text: string;
  at: number;
};
export type HxRoom = { id: string; title: string; description: string; topic: string; hostId: string; live: true };
export type HxPerson = { id: string; name: string; username: string; color: string; photoUrl: string | null; bio: string; following?: boolean };
export type HxMember = { id: string; name: string; username: string; color: string; photoUrl: string | null };
export type HxQuery = { tags: string[]; mentions: string[]; words: string[] };
export type HxResults = { query: HxQuery; messages: HxMessage[]; total: number | null; next: string | null; rooms: HxRoom[]; people: HxPerson[]; profiles: HxPerson[] };
export type HxSuggestion = { tag: string; count: number; last: number };

const cache = new Map<string, { at: number; data: unknown }>();
export async function hxGet<T>(url: string, ttl = 10_000): Promise<T | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  try {
    const r = await authFetch(url);
    if (!r.ok) return null;
    const j = (await r.json()) as T & { ok?: boolean };
    if (!j.ok) return null;
    if (cache.size > 150) cache.clear();
    cache.set(url, { at: Date.now(), data: j });
    return j;
  } catch {
    return null;
  }
}
export const hxForget = () => cache.clear();

export function searchUrl(o: { q: string; scope: "chat" | "messages" | "all"; chat?: string | null; from?: string | null; before?: string | null; limit?: number }) {
  const sp = new URLSearchParams({ q: o.q, scope: o.scope });
  if (o.chat) sp.set("chat", o.chat);
  if (o.from) sp.set("from", o.from);
  if (o.before) sp.set("before", o.before);
  if (o.limit) sp.set("limit", String(o.limit));
  return `/hx/search?${sp}`;
}

/** debounced search; `url` null = idle */
export function useHx<T>(url: string | null, delay = 180, ttl = 10_000) {
  const [state, setState] = useState<{ url: string | null; data: T | null; loading: boolean }>({ url: null, data: null, loading: false });
  useEffect(() => {
    if (!url) return;
    let live = true;
    const t = setTimeout(() => {
      setState((s) => ({ url, data: s.url === url ? s.data : null, loading: true }));
      hxGet<T>(url, ttl).then((data) => live && setState({ url, data, loading: false }));
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [url, delay, ttl]);
  if (!url) return { data: null, loading: false };
  return state.url === url ? state : { data: null, loading: true };
}
