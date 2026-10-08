"use client";
// One shared <audio> element for voice notes: only one plays at a time, the speed (1x/1.5x/2x) sticks, and when a note
// ends the next voice note below it starts on its own (Telegram). A single element also keeps iOS happy: once a tap has
// unlocked it, the next note can start from the `ended` handler without another gesture.
import { useSyncExternalStore } from "react";

export interface PlayerState {
  id: string | null;
  playing: boolean;
  position: number; // seconds
  duration: number; // seconds
  rate: number;
  loading: boolean;
}

let el: HTMLAudioElement | null = null;
let state: PlayerState = { id: null, playing: false, position: 0, duration: 0, rate: readRate(), loading: false };
const subs = new Set<() => void>();
const set = (p: Partial<PlayerState>) => {
  state = { ...state, ...p };
  subs.forEach((s) => s());
};
type Source = { id: string; resolveUrl: () => Promise<string | null>; durationS: number; onStart?: () => void };
const sources = new Map<string, Source>();
let raf = 0;

function readRate() {
  if (typeof localStorage === "undefined") return 1;
  const r = Number(localStorage.getItem("ol.voiceRate"));
  return r === 1.5 || r === 2 ? r : 1;
}

function audio() {
  if (el) return el;
  el = new Audio();
  el.preload = "auto";
  (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
  el.addEventListener("playing", () => set({ playing: true, loading: false }));
  el.addEventListener("pause", () => set({ playing: false }));
  el.addEventListener("waiting", () => set({ loading: true }));
  el.addEventListener("loadedmetadata", () => Number.isFinite(el!.duration) && set({ duration: el!.duration }));
  el.addEventListener("ended", () => {
    const done = state.id;
    set({ playing: false, position: 0 });
    if (done) playNextAfter(done);
  });
  el.addEventListener("error", () => set({ playing: false, loading: false }));
  return el;
}

function tick() {
  if (!el) return;
  set({ position: el.currentTime });
  if (!el.paused) raf = requestAnimationFrame(tick);
}

export function registerVoice(s: Source) {
  sources.set(s.id, s);
  return () => {
    sources.delete(s.id);
  };
}

export async function playVoice(id: string, from?: number) {
  const s = sources.get(id);
  if (!s) return;
  const a = audio();
  if (state.id === id && a.src) {
    if (from !== undefined) a.currentTime = from;
    a.playbackRate = state.rate;
    await a.play().catch(() => {});
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    return;
  }
  a.pause();
  set({ id, playing: false, position: from ?? 0, duration: s.durationS, loading: true });
  const url = await s.resolveUrl();
  if (!url || state.id !== id) return set({ loading: false });
  a.src = url;
  a.playbackRate = state.rate;
  (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  if (from) a.currentTime = from;
  s.onStart?.();
  await a.play().catch(() => set({ loading: false }));
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function pauseVoice() {
  el?.pause();
}

export function seekVoice(id: string, seconds: number) {
  if (state.id === id && el) {
    el.currentTime = seconds;
    set({ position: seconds });
  } else set({ id, position: seconds, playing: false, duration: sources.get(id)?.durationS ?? 0 });
}

export function cycleRate() {
  const r = state.rate === 1 ? 1.5 : state.rate === 1.5 ? 2 : 1;
  try {
    localStorage.setItem("ol.voiceRate", String(r));
  } catch {}
  if (el) el.playbackRate = r;
  set({ rate: r });
}

/** auto-play: the next voice note below this one in the thread (DOM order) */
function playNextAfter(id: string) {
  if (typeof document === "undefined") return;
  const nodes = [...document.querySelectorAll<HTMLElement>("[data-voice-id]")];
  const i = nodes.findIndex((n) => n.dataset.voiceId === id);
  const next = i >= 0 ? nodes[i + 1] : null;
  if (next?.dataset.voiceId && sources.has(next.dataset.voiceId)) void playVoice(next.dataset.voiceId, 0);
  else set({ id: null });
}

export function useVoicePlayer() {
  return useSyncExternalStore(
    (cb) => (subs.add(cb), () => subs.delete(cb)),
    () => state,
    () => state,
  );
}

const idle: Record<number, PlayerState> = {};
/** Per-tile view of the player: tiles that aren't playing get a stable snapshot (no re-render on every frame). */
export function useVoiceState(id: string) {
  return useSyncExternalStore(
    (cb) => (subs.add(cb), () => subs.delete(cb)),
    () => (state.id === id ? state : (idle[state.rate] ??= { id: null, playing: false, position: 0, duration: 0, rate: state.rate, loading: false })),
    () => (idle[1] ??= { id: null, playing: false, position: 0, duration: 0, rate: 1, loading: false }),
  );
}
