"use client";
// Client state for the sticker library: catalog (cached in memory + localStorage, revalidated in the background),
// My stickers / favorites / recents (optimistic, synced to /api/stickers/me), and pack lookups for rendering.
import { useSyncExternalStore } from "react";
import { getAccessToken } from "../auth";
import { inNativeShell } from "../authApi";
import type { MyStickers, PackSummary, Receipt, Sticker, StickerConfig, StickerPack } from "./types";

const LS_CATALOG = "ol:stickers:catalog:v1";
const LS_PACK = "ol:stickers:pack:v1:";
const LS_MINE = "ol:stickers:mine:v1";

export const fileUrl = (rel: string) => `/sticker-files/${rel}`;

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const t = await getAccessToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = opts.auth === false ? {} : await authHeaders();
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`/api/stickers${path}`, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
  const j = (await r.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!r.ok || !j || j.ok === false) throw Object.assign(new Error(j?.error || "Something went wrong"), { status: r.status, data: j });
  return j;
}

const read = <T,>(k: string): T | null => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* quota / private mode */
  }
};

// ---------- tiny external store ----------
interface State {
  catalog: { packs: PackSummary[]; categories: string[] } | null;
  packs: Record<string, StickerPack>;
  mine: MyStickers | null;
  config: StickerConfig | null;
  wrapper: boolean;
}
let state: State = { catalog: null, packs: {}, mine: null, config: null, wrapper: false };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const SERVER: State = { catalog: null, packs: {}, mine: null, config: null, wrapper: false };
export function useStickers<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(SERVER));
}
export const stickerState = () => state;

let hydrated = false;
function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const c = read<State["catalog"]>(LS_CATALOG);
  const m = read<MyStickers>(LS_MINE);
  set({ catalog: c ?? state.catalog, mine: m ?? state.mine });
}

let catalogP: Promise<void> | null = null;
export function loadCatalog(force = false) {
  hydrate();
  if (catalogP && !force) return catalogP;
  catalogP = api<{ packs: PackSummary[]; categories: string[] }>("/packs", { auth: false })
    .then((r) => {
      const catalog = { packs: r.packs, categories: r.categories };
      write(LS_CATALOG, catalog);
      set({ catalog });
    })
    .catch(() => {
      catalogP = null;
    });
  return catalogP;
}

const packP = new Map<string, Promise<StickerPack | null>>();
export function loadPack(id: string): Promise<StickerPack | null> {
  hydrate();
  if (state.packs[id]) {
    // revalidate quietly once per session
    if (!packP.has(id)) packP.set(id, fetchPack(id));
    return Promise.resolve(state.packs[id]);
  }
  const cached = read<StickerPack>(LS_PACK + id);
  if (cached) {
    set({ packs: { ...state.packs, [id]: cached } });
    if (!packP.has(id)) packP.set(id, fetchPack(id));
    return Promise.resolve(cached);
  }
  if (!packP.has(id)) packP.set(id, fetchPack(id));
  return packP.get(id)!;
}
async function fetchPack(id: string) {
  try {
    const r = await api<{ pack: StickerPack }>(`/packs/${encodeURIComponent(id)}`, { auth: false });
    write(LS_PACK + id, r.pack);
    set({ packs: { ...state.packs, [id]: r.pack } });
    return r.pack;
  } catch {
    packP.delete(id);
    return null;
  }
}
export const findSticker = (packId: string, stickerId: string): Sticker | null => state.packs[packId]?.stickers.find((s) => s.id === stickerId) ?? null;

let configP: Promise<void> | null = null;
export function loadConfig() {
  if (!configP)
    configP = api<{ config: StickerConfig; wrapper: boolean }>("/config", { auth: false })
      .then((r) => set({ config: r.config, wrapper: r.wrapper }))
      .catch(() => {
        configP = null;
      });
  return configP;
}

let mineP: Promise<void> | null = null;
export function loadMine(force = false) {
  hydrate();
  if (mineP && !force) return mineP;
  mineP = api<{ mine: MyStickers }>("/me")
    .then((r) => setMine(r.mine))
    .catch(() => {
      mineP = null;
    });
  return mineP;
}
function setMine(m: MyStickers) {
  write(LS_MINE, m);
  set({ mine: m });
}
const EMPTY: MyStickers = { added: [], favorites: [], recents: [], owned: [] };

export async function setAdded(packId: string, add: boolean) {
  const prev = state.mine ?? EMPTY;
  setMine({ ...prev, added: add ? [packId, ...prev.added.filter((x) => x !== packId)] : prev.added.filter((x) => x !== packId) });
  try {
    const r = await api<{ mine: MyStickers }>("/me/packs", { body: { packId, add } });
    setMine(r.mine);
  } catch (e) {
    setMine(prev);
    throw e;
  }
}

export async function setFavorite(packId: string, stickerId: string, fav: boolean) {
  const prev = state.mine ?? EMPTY;
  const rest = prev.favorites.filter((f) => !(f.packId === packId && f.stickerId === stickerId));
  setMine({ ...prev, favorites: fav ? [{ packId, stickerId }, ...rest] : rest });
  try {
    const r = await api<{ mine: MyStickers }>("/me/favorites", { body: { packId, stickerId, fav } });
    setMine(r.mine);
  } catch {
    setMine(prev);
  }
}

export function noteRecent(packId: string, stickerId: string) {
  const prev = state.mine ?? EMPTY;
  const rest = prev.recents.filter((f) => !(f.packId === packId && f.stickerId === stickerId));
  setMine({ ...prev, recents: [{ packId, stickerId }, ...rest].slice(0, 30) });
  void api("/me/recents", { body: { packId, stickerId } }).catch(() => {});
}

export async function reorderMine(packIds: string[]) {
  const prev = state.mine ?? EMPTY;
  setMine({ ...prev, added: packIds });
  await api("/me/order", { body: { packIds } }).catch(() => setMine(prev));
}

export const isFavorite = (m: MyStickers | null, packId: string, stickerId: string) => !!m?.favorites.some((f) => f.packId === packId && f.stickerId === stickerId);

export async function restorePurchases() {
  const r = await api<{ mine: MyStickers; receipts: Receipt[] }>("/restore", { body: {} });
  setMine(r.mine);
  return r.receipts;
}
export async function loadReceipts() {
  return (await api<{ receipts: Receipt[] }>("/receipts")).receipts;
}
export function applyMine(m: MyStickers) {
  setMine(m);
}

/** Inside the Android/iOS WebView wrappers? (paid buy buttons stay hidden there; see STORE_RULES.md) */
export function inWrapper() {
  if (typeof navigator === "undefined") return false;
  return state.wrapper || inNativeShell();
}
