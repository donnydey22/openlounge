"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Switch } from "@/components/Switch";
import { SponsoredCard, type SponsoredAd } from "@/components/sponsored/Sponsored";
import { authFetch } from "@/lib/auth";
import { formatFull } from "@/lib/time";
import { cn } from "@/lib/utils";

type Ad = SponsoredAd & { placements: ("rooms" | "groups")[]; minGroupSize: number; startsAt: number; endsAt: number | null; enabled: boolean; updatedAt: number };
type Draft = {
  advertiser: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  rooms: boolean;
  groups: boolean;
  minGroupSize: number;
  start: string;
  end: string;
  avatarData?: string | null;
  imageData?: string | null;
  avatarPreview?: string | null;
  imagePreview?: { src: string; w: number; h: number } | null;
};

const pad = (n: number) => String(n).padStart(2, "0");
const toLocal = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocal = (s: string) => (s ? new Date(s).getTime() : 0);
const EMPTY = (): Draft => ({ advertiser: "", title: "", body: "", ctaLabel: "Learn more", ctaUrl: "https://", rooms: true, groups: false, minGroupSize: 100, start: toLocal(Date.now()), end: "" });

function readFile(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}
function imgSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth || 1, h: i.naturalHeight || 1 });
    i.onerror = () => res({ w: 16, h: 9 });
    i.src = src;
  });
}

function status(a: Ad, now: number) {
  if (!a.enabled) return { label: "Off", cls: "text-zinc-500" };
  if (a.endsAt && a.endsAt <= now) return { label: "Ended", cls: "text-zinc-500" };
  if (a.startsAt > now) return { label: "Scheduled", cls: "text-amber-300" };
  return { label: "Running", cls: "text-emerald-300" };
}

/** Admin-only (server checks ADMIN_USER_IDS): create, schedule and switch off sponsored messages. */
export default function AdminSponsoredPage() {
  const [data, setData] = useState<{ enabled: boolean; ads: Ad[]; now: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; d: Draft } | null>(null);

  const call = useCallback(async (init?: { op: string; [k: string]: unknown }) => {
    setError(null);
    try {
      const r = await authFetch("/sp/admin", init ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(init) } : {});
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(r.status === 403 ? "This page is for Open Lounge admins only." : d?.error || "That didn't work");
      setData({ enabled: d.enabled, ads: d.ads, now: d.now });
      return true;
    } catch (e) {
      setError((e as Error).message);
      setData((x) => x ?? { enabled: false, ads: [], now: Date.now() });
      return false;
    }
  }, []);
  useEffect(() => {
    void call();
  }, [call]);

  const save = async () => {
    if (!edit) return;
    const { d, id } = edit;
    setBusy("save");
    const ad = {
      advertiser: d.advertiser,
      title: d.title,
      body: d.body,
      ctaLabel: d.ctaLabel,
      ctaUrl: d.ctaUrl,
      placements: [d.rooms && "rooms", d.groups && "groups"].filter(Boolean),
      minGroupSize: d.minGroupSize,
      startsAt: fromLocal(d.start) || Date.now(),
      endsAt: fromLocal(d.end) || null,
      ...(d.avatarData !== undefined ? { avatarData: d.avatarData } : {}),
      ...(d.imageData !== undefined ? { imageData: d.imageData } : {}),
    };
    const ok = await call(id ? { op: "update", id, ad } : { op: "create", ad });
    setBusy(null);
    if (ok) setEdit(null);
  };

  const now = data?.now ?? Date.now();
  const d = edit?.d;
  const set = (patch: Partial<Draft>) => setEdit((e) => (e ? { ...e, d: { ...e.d, ...patch } } : e));
  const preview: SponsoredAd | null = d
    ? { id: "sp_preview", advertiser: d.advertiser || "Advertiser", title: d.title || "Title", body: d.body, ctaLabel: d.ctaLabel || "Learn more", ctaUrl: d.ctaUrl, avatar: d.avatarPreview ?? null, image: d.imagePreview ?? null }
    : null;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))]">
        <h1 className="text-2xl font-bold text-zinc-50">Sponsored messages</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Shown at the bottom of the room list and in large groups, at most one per screen, never in 1:1 chats. Nothing about viewers is used to pick them and no views or taps are tracked.
        </p>
        {error && <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
        {!data ? (
          <div className="mt-8 flex justify-center text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="mt-5 flex items-center justify-between gap-3 rounded-3xl border border-white/5 bg-zinc-900/70 p-4">
              <div>
                <div className="font-semibold text-zinc-100">Sponsored slot</div>
                <div className="text-sm text-zinc-500">{data.enabled ? "On — running messages are shown" : "Off — nothing is shown anywhere"}</div>
              </div>
              <Switch label="Sponsored slot" on={data.enabled} disabled={busy === "switch"} onChange={async (v) => (setBusy("switch"), await call({ op: "switch", enabled: v }), setBusy(null))} />
            </div>

            {!edit && (
              <button
                type="button"
                onClick={() => setEdit({ id: null, d: EMPTY() })}
                className="mt-4 flex h-11 items-center gap-2 rounded-2xl bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/25"
              >
                <Plus className="h-4 w-4" /> New sponsored message
              </button>
            )}

            {edit && d && (
              <div className="mt-4 space-y-3 rounded-3xl border border-white/5 bg-zinc-900/70 p-4">
                <div className="font-semibold text-zinc-100">{edit.id ? "Edit" : "New"} sponsored message</div>
                <Field label="Advertiser">
                  <input className={INPUT} maxLength={48} value={d.advertiser} onChange={(e) => set({ advertiser: e.target.value })} />
                </Field>
                <Field label="Advertiser avatar (optional)">
                  <FilePick
                    has={!!d.avatarPreview}
                    onPick={async (f) => {
                      const src = await readFile(f);
                      set({ avatarData: src, avatarPreview: src });
                    }}
                    onClear={() => set({ avatarData: null, avatarPreview: null })}
                  />
                </Field>
                <Field label="Title">
                  <input className={INPUT} maxLength={80} value={d.title} onChange={(e) => set({ title: e.target.value })} />
                </Field>
                <Field label="Text">
                  <textarea className={cn(INPUT, "h-24 py-2")} maxLength={300} value={d.body} onChange={(e) => set({ body: e.target.value })} />
                </Field>
                <Field label="Image (optional)">
                  <FilePick
                    has={!!d.imagePreview}
                    onPick={async (f) => {
                      const src = await readFile(f);
                      const { w, h } = await imgSize(src);
                      set({ imageData: src, imagePreview: { src, w, h } });
                    }}
                    onClear={() => set({ imageData: null, imagePreview: null })}
                  />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr]">
                  <Field label="Button label">
                    <input className={INPUT} maxLength={24} value={d.ctaLabel} onChange={(e) => set({ ctaLabel: e.target.value })} />
                  </Field>
                  <Field label="Button link (https://)">
                    <input className={INPUT} inputMode="url" value={d.ctaUrl} onChange={(e) => set({ ctaUrl: e.target.value })} />
                  </Field>
                </div>
                <Field label="Where">
                  <div className="flex flex-wrap gap-4 text-sm text-zinc-200">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={d.rooms} onChange={(e) => set({ rooms: e.target.checked })} /> Bottom of the room list
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={d.groups} onChange={(e) => set({ groups: e.target.checked })} /> Groups with at least
                      <input
                        type="number"
                        min={10}
                        className={cn(INPUT, "h-9 w-24")}
                        value={d.minGroupSize}
                        onChange={(e) => set({ minGroupSize: Number(e.target.value) })}
                      />
                      members
                    </label>
                  </div>
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Starts">
                    <input type="datetime-local" className={INPUT} value={d.start} onChange={(e) => set({ start: e.target.value })} />
                  </Field>
                  <Field label="Ends (optional)">
                    <input type="datetime-local" className={INPUT} value={d.end} onChange={(e) => set({ end: e.target.value })} />
                  </Field>
                </div>
                {preview && (
                  <div>
                    <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">Preview</div>
                    <SponsoredCard ad={preview} />
                  </div>
                )}
                <div className="flex gap-2">
                  <button type="button" onClick={save} disabled={busy === "save"} className="h-11 rounded-2xl bg-emerald-500 px-5 text-sm font-semibold text-black disabled:opacity-60">
                    {busy === "save" ? "Saving…" : edit.id ? "Save" : "Create (off)"}
                  </button>
                  <button type="button" onClick={() => setEdit(null)} className="h-11 rounded-2xl px-4 text-sm text-zinc-300 hover:bg-white/5">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <ul className="mt-5 space-y-3">
              {data.ads.length === 0 && <li className="rounded-3xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">No sponsored messages yet.</li>}
              {data.ads.map((a) => {
                const st = status(a, now);
                return (
                  <li key={a.id} className="rounded-3xl border border-white/5 bg-zinc-900/70 p-4">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-zinc-100">{a.title}</div>
                        <div className="truncate text-sm text-zinc-400">{a.advertiser}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          <span className={cn("font-semibold", st.cls)}>{st.label}</span> · {a.placements.map((p) => (p === "rooms" ? "Room list" : `Groups ≥ ${a.minGroupSize}`)).join(", ")} ·{" "}
                          {formatFull(a.startsAt)}
                          {a.endsAt ? ` → ${formatFull(a.endsAt)}` : ""}
                        </div>
                      </div>
                      <Switch
                        label={`Enable ${a.title}`}
                        on={a.enabled}
                        disabled={busy === a.id}
                        onChange={async (v) => (setBusy(a.id), await call({ op: "update", id: a.id, ad: { enabled: v } }), setBusy(null))}
                      />
                    </div>
                    <div className="mt-3 flex gap-2 text-sm">
                      <button
                        type="button"
                        className="h-9 rounded-xl px-3 text-zinc-300 hover:bg-white/5"
                        onClick={() =>
                          setEdit({
                            id: a.id,
                            d: {
                              advertiser: a.advertiser,
                              title: a.title,
                              body: a.body,
                              ctaLabel: a.ctaLabel,
                              ctaUrl: a.ctaUrl,
                              rooms: a.placements.includes("rooms"),
                              groups: a.placements.includes("groups"),
                              minGroupSize: a.minGroupSize,
                              start: toLocal(a.startsAt),
                              end: a.endsAt ? toLocal(a.endsAt) : "",
                              avatarPreview: a.avatar,
                              imagePreview: a.image,
                            },
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="flex h-9 items-center gap-1.5 rounded-xl px-3 text-red-400 hover:bg-red-500/10"
                        onClick={async () => {
                          if (!window.confirm(`Delete "${a.title}"?`)) return;
                          setBusy(a.id);
                          await call({ op: "delete", id: a.id });
                          setBusy(null);
                        }}
                      >
                        <Trash2 className="h-4 w-4" /> Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>
    </>
  );
}

const INPUT = "h-11 w-full rounded-xl border border-white/10 bg-zinc-950 px-3 text-[16px] text-zinc-100 outline-none focus:border-emerald-400/50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function FilePick({ has, onPick, onClear }: { has: boolean; onPick: (f: File) => void; onClear: () => void }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="min-w-0 text-zinc-300" onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])} />
      {has && (
        <button type="button" onClick={onClear} className="text-zinc-400 underline">
          Remove
        </button>
      )}
    </div>
  );
}
