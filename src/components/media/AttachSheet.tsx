"use client";
// Attach: 📎 → Photo or video / Camera / File, then a preview sheet with a caption, "Send as file", and the
// self-destruct timer (Off, 1 min, 1 hour, 1 day, 1 week, Custom up to 30 days, View once). Also takes pasted and
// dropped files.
import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, File as FileIcon, Flame, GripVertical, Images, Paperclip, Plus, Timer, Video, X } from "lucide-react";
import { VideoRecorderSheet } from "./VideoRecorder";
import { Sheet } from "../Sheet";
import { cn } from "@/lib/utils";
import { VideoFirstFrame } from "./VideoFirstFrame";
import { ALBUM_MAX, MAX_TTL_SECONDS, TTL_PRESETS, formatBytes, formatDuration } from "@/lib/media/types";
import { kindForFile, sizeError } from "@/lib/media/outbox";

export interface AttachSend {
  files: File[];
  asFile: boolean;
  caption: string;
  ttlSeconds: number;
  viewOnce: boolean;
  /** 2+ photos/videos grouped into album message(s) of up to 10 */
  album: boolean;
}
export type PickSource = "gallery" | "camera" | "file" | "paste";

const isTouch = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

export function AttachButton({ disabled, onPick }: { disabled?: boolean; onPick: (files: File[], asFile: boolean, source: PickSource) => void }) {
  const [menu, setMenu] = useState(false);
  const [recOpen, setRecOpen] = useState(false);
  const media = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const take = (e: React.ChangeEvent<HTMLInputElement>, asFile: boolean, source: PickSource) => {
    const list = [...(e.target.files ?? [])];
    e.target.value = "";
    setMenu(false);
    if (list.length) onPick(list, asFile, source);
  };
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setMenu(true)}
        aria-label="Attach a photo, video or file"
        data-testid="attach-button"
        className="flex h-[42px] w-[38px] shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:text-zinc-100 disabled:opacity-40"
      >
        <Paperclip className="h-[21px] w-[21px] -rotate-45" />
      </button>
      <input ref={media} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => take(e, false, "gallery")} data-testid="attach-input-media" />
      <input ref={camera} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => take(e, false, "camera")} />
      <input ref={file} type="file" multiple hidden onChange={(e) => take(e, true, "file")} data-testid="attach-input-file" />
      <Sheet open={menu} onClose={() => setMenu(false)} title="Attach">
        <div className="grid grid-cols-3 gap-2 pb-2">
          <MenuTile icon={<Images className="h-6 w-6" />} label="Photo or video" color="bg-sky-500" onClick={() => media.current?.click()} />
          {isTouch() && <MenuTile icon={<Camera className="h-6 w-6" />} label="Camera" color="bg-rose-500" onClick={() => camera.current?.click()} />}
          <MenuTile icon={<FileIcon className="h-6 w-6" />} label="File" color="bg-violet-500" onClick={() => file.current?.click()} />
          <MenuTile
            icon={<Video className="h-6 w-6" />}
            label="Video message"
            color="bg-emerald-500"
            testId="attach-video-message"
            onClick={() => {
              setMenu(false);
              setRecOpen(true);
            }}
          />
        </div>
      </Sheet>
      <VideoRecorderSheet
        open={recOpen}
        onClose={() => setRecOpen(false)}
        onRecorded={(f) => {
          setRecOpen(false);
          onPick([f], false, "camera");
        }}
      />
    </>
  );
}

function MenuTile({ icon, label, color, onClick, testId }: { icon: React.ReactNode; label: string; color: string; onClick: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} className="flex flex-col items-center gap-2 rounded-2xl p-3 text-[13px] font-medium text-zinc-200 hover:bg-white/5">
      <span className={cn("flex h-14 w-14 items-center justify-center rounded-full text-white", color)}>{icon}</span>
      {label}
    </button>
  );
}

const UNITS = [
  { label: "minutes", s: 60 },
  { label: "hours", s: 3600 },
  { label: "days", s: 86_400 },
];

function ttlLabel(ttl: number, viewOnce: boolean) {
  if (viewOnce) return "View once";
  if (!ttl) return "Off";
  const p = TTL_PRESETS.find((x) => x.seconds === ttl);
  if (p) return p.label;
  if (ttl % 86_400 === 0) return `${ttl / 86_400} days`;
  if (ttl % 3600 === 0) return `${ttl / 3600} hours`;
  return `${Math.round(ttl / 60)} minutes`;
}

let trayKey = 0;
interface TrayItem {
  key: number;
  file: File;
}
const toTray = (files: File[]): TrayItem[] => files.map((file) => ({ key: ++trayKey, file }));

export function AttachPreview({
  files,
  asFile: asFile0,
  onClose,
  onSend,
  peerName,
  source = "gallery",
  allowViewOnce = true,
}: {
  files: File[];
  asFile: boolean;
  onClose: () => void;
  onSend: (s: AttachSend) => void;
  peerName?: string;
  source?: PickSource;
  /** false in groups (view once is 1:1 only; timers still work) */
  allowViewOnce?: boolean;
}) {
  const [tray, setTray] = useState<TrayItem[]>(() => toTray(files));
  const list = useMemo(() => tray.map((t) => t.file), [tray]);
  const setList = (l: File[]) => setTray((cur) => l.map((f) => cur.find((t) => t.file === f) ?? { key: ++trayKey, file: f }));
  const [group, setGroup] = useState(true);
  const more = useRef<HTMLInputElement>(null);
  const moreCam = useRef<HTMLInputElement>(null);
  const addMore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const add = [...(e.target.files ?? [])];
    e.target.value = "";
    if (add.length) setTray((cur) => [...cur, ...toTray(add)]);
  };
  // drag to reorder (pointer events: touch + mouse + pen; the grip also takes ←/→)
  const dragKey = useRef<number | null>(null);
  const move = (from: number, to: number) =>
    setTray((cur) => {
      if (to < 0 || to >= cur.length || from === to) return cur;
      const next = [...cur];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  const onGripDown = (e: React.PointerEvent, key: number) => {
    e.preventDefault();
    e.stopPropagation();
    dragKey.current = key;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onGripMove = (e: React.PointerEvent) => {
    if (dragKey.current === null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-tray-idx]") as HTMLElement | null;
    if (!el) return;
    const to = Number(el.dataset.trayIdx);
    setTray((cur) => {
      const from = cur.findIndex((t) => t.key === dragKey.current);
      if (from < 0 || from === to) return cur;
      const next = [...cur];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  };
  const onGripUp = () => (dragKey.current = null);
  const [asFile, setAsFile] = useState(asFile0);
  const [caption, setCaption] = useState("");
  const [ttl, setTtl] = useState(0);
  const [viewOnce, setViewOnce] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customN, setCustomN] = useState("2");
  const [customUnit, setCustomUnit] = useState(1);
  const visual = list.length > 0 && list.every((f) => kindForFile(f) !== "document");
  const album = visual && !asFile && group && list.length > 1;
  const albums = album ? Math.ceil(list.length / ALBUM_MAX) : 0;
  const errors = list.map((f) => sizeError(f, kindForFile(f, asFile)));
  const blocked = errors.some(Boolean);
  const expiring = ttl > 0 || viewOnce;
  // one object URL per tray item, kept across reorders (no flicker), revoked when removed / on close
  const urlCache = useRef(new Map<number, string | null>());
  const previews = tray.map((t) => {
    if (!urlCache.current.has(t.key)) urlCache.current.set(t.key, kindForFile(t.file) !== "document" ? URL.createObjectURL(t.file) : null);
    return urlCache.current.get(t.key)!;
  });
  useEffect(() => {
    const live = new Set(tray.map((t) => t.key));
    for (const [k, u] of urlCache.current) if (!live.has(k)) (u && URL.revokeObjectURL(u), urlCache.current.delete(k));
  }, [tray]);
  useEffect(() => {
    const cache = urlCache.current;
    return () => cache.forEach((u) => u && URL.revokeObjectURL(u));
  }, []);

  const send = () => {
    if (!list.length || blocked) return;
    onSend({ files: list, asFile: asFile || !visual, caption: expiring ? "" : caption, ttlSeconds: viewOnce ? 0 : ttl, viewOnce: viewOnce && visual && !asFile && !album, album });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={list.length > 1 ? (album ? `Album · ${list.length} items` : `${list.length} ${visual && !asFile ? "items" : "files"}`) : visual && !asFile ? (kindForFile(list[0]) === "video" ? "Send video" : "Send photo") : "Send file"}
      footer={
        <div className="flex items-end gap-2">
          {!expiring ? (
            <textarea
              rows={1}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              maxLength={2000}
              placeholder="Add a caption…"
              className="block max-h-24 min-w-0 flex-1 resize-none rounded-2xl border border-white/10 bg-zinc-950 px-4 py-2.5 text-[15px] outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-[13px] text-zinc-400">
              <Flame className="h-4 w-4 shrink-0 text-amber-400" />
              <span className="truncate">{viewOnce ? `${peerName ?? "They"} can open it once` : `Disappears ${ttlLabel(ttl, false).replace(/^1 /, "a ")} after sending`}</span>
            </div>
          )}
          <button type="button" onClick={send} disabled={blocked} data-testid="attach-send" className="h-[42px] shrink-0 rounded-full bg-emerald-500 px-5 text-[15px] font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40">
            Send
          </button>
        </div>
      }
    >
      <div className={cn("grid gap-2", list.length === 1 ? "grid-cols-1" : "grid-cols-3")} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp} data-testid="attach-tray">
        {tray.map(({ key, file: f }, i) => (
          <div key={key} data-tray-idx={i} className={cn("relative overflow-hidden rounded-xl bg-zinc-900", list.length === 1 && previews[i] ? "max-h-[38dvh]" : "aspect-square")} data-testid="tray-item">
            {previews[i] && kindForFile(f) === "photo" && <img src={previews[i]!} alt="" className={cn("h-full w-full", list.length === 1 ? "max-h-[38dvh] object-contain" : "object-cover")} />}
            {previews[i] && kindForFile(f) === "video" && <VideoFirstFrame src={previews[i]!} testId="tray-video" className={cn("relative h-full w-full", list.length === 1 ? "min-h-[160px] max-h-[38dvh] object-contain" : "object-cover")} />}
            {!previews[i] && (
              <div className="flex h-full min-h-[64px] items-center gap-3 p-3">
                <FileIcon className="h-6 w-6 shrink-0 text-zinc-400" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{f.name}</div>
                  <div className="text-xs text-zinc-500">{formatBytes(f.size)}</div>
                </div>
              </div>
            )}
            {errors[i] && <div className="absolute inset-x-0 bottom-0 bg-red-600/90 px-2 py-1 text-[11px] font-medium text-white">{errors[i]}</div>}
            <button type="button" onClick={() => (list.length === 1 ? onClose() : setList(list.filter((_, j) => j !== i)))} aria-label="Remove" data-testid="tray-remove" className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-white">
              <X className="h-3.5 w-3.5" />
            </button>
            {list.length > 1 && (
              <>
                <button
                  type="button"
                  onPointerDown={(e) => onGripDown(e, key)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      move(i, i + (e.key === "ArrowRight" ? 1 : -1));
                    }
                  }}
                  aria-label={`Reorder item ${i + 1} (drag, or use the arrow keys)`}
                  className="absolute top-1 left-1 cursor-grab touch-none rounded-full bg-black/60 p-1 text-white active:cursor-grabbing"
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </button>
                {album && <span className="pointer-events-none absolute bottom-1 left-1 rounded-full bg-black/60 px-1.5 text-[11px] font-semibold text-white tabular-nums">{(i % ALBUM_MAX) + 1}</span>}
              </>
            )}
          </div>
        ))}
        {visual && !asFile && (
          <button
            type="button"
            onClick={() => (source === "camera" ? moreCam : more).current?.click()}
            className={cn("flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/15 text-[12px] font-semibold text-zinc-300 hover:bg-white/5", list.length === 1 ? "h-14" : "aspect-square")}
            data-testid="tray-add"
          >
            {source === "camera" ? <Camera className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
            {source === "camera" ? "+ another" : "Add"}
          </button>
        )}
      </div>
      <input ref={more} type="file" accept="image/*,video/*" multiple hidden onChange={addMore} />
      <input ref={moreCam} type="file" accept="image/*,video/*" capture="environment" hidden onChange={addMore} />
      <div className="mt-3 space-y-1">
        {visual && !asFile && list.length > 1 && (
          <label className="flex cursor-pointer items-center justify-between rounded-xl px-2 py-2.5 text-[14px] text-zinc-200 hover:bg-white/5">
            <span>
              Group as album
              {albums > 1 && <span className="text-zinc-500"> · sends {albums} albums (up to {ALBUM_MAX} each)</span>}
            </span>
            <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} className="h-5 w-5 accent-emerald-500" data-testid="tray-group" />
          </label>
        )}
        {visual && (
          <label className="flex cursor-pointer items-center justify-between rounded-xl px-2 py-2.5 text-[14px] text-zinc-200 hover:bg-white/5">
            <span>
              Send as file <span className="text-zinc-500">· original quality</span>
            </span>
            <input type="checkbox" checked={asFile} onChange={(e) => setAsFile(e.target.checked)} className="h-5 w-5 accent-emerald-500" />
          </label>
        )}
        <button type="button" onClick={() => setTimerOpen((o) => !o)} className="flex w-full items-center justify-between rounded-xl px-2 py-2.5 text-[14px] text-zinc-200 hover:bg-white/5" data-testid="attach-timer">
          <span className="flex items-center gap-2">
            <Timer className="h-4 w-4 text-zinc-400" /> Self-destruct
          </span>
          <span className={cn("font-semibold", expiring ? "text-amber-400" : "text-zinc-500")}>{ttlLabel(ttl, viewOnce)}</span>
        </button>
        {timerOpen && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-1">
            {TTL_PRESETS.map((p) => (
              <Chip
                key={p.seconds}
                on={!viewOnce && ttl === p.seconds && !customOpen}
                onClick={() => {
                  setTtl(p.seconds);
                  setViewOnce(false);
                  setCustomOpen(false);
                }}
              >
                {p.label}
              </Chip>
            ))}
            <Chip on={customOpen} onClick={() => setCustomOpen(true)}>
              Custom
            </Chip>
            {allowViewOnce && visual && !asFile && !album && (
              <Chip
                on={viewOnce}
                onClick={() => {
                  setViewOnce(true);
                  setTtl(0);
                  setCustomOpen(false);
                }}
              >
                View once
              </Chip>
            )}
            {customOpen && (
              <div className="mt-1 flex w-full items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={customN}
                  onChange={(e) => {
                    setCustomN(e.target.value);
                    const s = Math.min(MAX_TTL_SECONDS, Math.max(60, Math.round(Number(e.target.value) || 0) * UNITS[customUnit].s));
                    setTtl(s);
                    setViewOnce(false);
                  }}
                  className="w-20 rounded-xl border border-white/10 bg-zinc-950 px-3 py-2 text-[15px] outline-none focus:border-emerald-500/60"
                  aria-label="Custom timer amount"
                />
                <select
                  value={customUnit}
                  onChange={(e) => {
                    const u = Number(e.target.value);
                    setCustomUnit(u);
                    setTtl(Math.min(MAX_TTL_SECONDS, Math.max(60, Math.round(Number(customN) || 0) * UNITS[u].s)));
                    setViewOnce(false);
                  }}
                  className="rounded-xl border border-white/10 bg-zinc-950 px-3 py-2 text-[15px] outline-none"
                  aria-label="Custom timer unit"
                >
                  {UNITS.map((u, i) => (
                    <option key={u.label} value={i}>
                      {u.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-zinc-500">up to 30 days</span>
              </div>
            )}
          </div>
        )}
        {expiring && album && <p className="px-2 text-[12px] leading-snug text-zinc-500">The timer applies to the whole album.</p>}
        {expiring && <p className="px-2 text-[12px] leading-snug text-zinc-500">The timer starts when you send. Screenshots can&apos;t be fully blocked on the web.</p>}
        {list.some((f) => kindForFile(f) === "video") && !asFile && <p className="px-2 text-[12px] text-zinc-500">Videos are optimised for fast playback on every device.</p>}
      </div>
    </Sheet>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn("rounded-full px-3 py-1.5 text-[13px] font-semibold transition", on ? "bg-amber-400 text-zinc-950" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700")}>
      {children}
    </button>
  );
}

export { formatDuration };
