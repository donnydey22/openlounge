"use client";
// Admin tool: add a sticker pack → upload stickers (WebP/PNG/GIF, static or animated, or Lottie .json) → set the
// price (FREE by default; $0.99 / $1.99 / $2.99 tiers) → publish. Admins only (server enforces).
import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useApp } from "@/components/AppProvider";
import { StickerView } from "@/components/stickers/StickerView";
import { getAccessToken } from "@/lib/auth";
import { PRICE_TIERS, formatPrice, type PackSummary, type StickerPack } from "@/lib/stickers/types";
import { cn } from "@/lib/utils";

async function admin<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/admin/stickers${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || `Error ${r.status}`);
  return j as T;
}

const readAs = (f: File, how: "text" | "dataurl") =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    if (how === "text") fr.readAsText(f);
    else fr.readAsDataURL(f);
  });

function PriceSelect({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <select
      value={value ?? 0}
      onChange={(e) => onChange(Number(e.target.value) || null)}
      className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-3 text-[16px] sm:text-sm"
      aria-label="Price"
      data-testid="admin-price"
    >
      <option value={0}>Free</option>
      {PRICE_TIERS.map((t) => (
        <option key={t} value={t}>
          {formatPrice(t)}
        </option>
      ))}
    </select>
  );
}

export default function AdminStickers() {
  const { toast } = useApp();
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [sel, setSel] = useState<StickerPack | null>(null);
  const [form, setForm] = useState({ title: "", emoji: "✨", category: "", description: "", priceCents: null as number | null });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      if (!(await admin<{ admin: boolean }>("/access")).admin) {
        setDenied(true);
        setPacks([]);
        return;
      }
      const r = await admin<{ packs: PackSummary[] }>("/packs");
      setPacks(r.packs);
    } catch (e) {
      if (/Admins only/.test((e as Error).message)) setDenied(true);
      setPacks([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (id: string) => setSel((await admin<{ pack: StickerPack }>(`/packs/${id}`)).pack);
  const save = async (patch: Record<string, unknown>) => {
    if (!sel) return;
    try {
      const r = await admin<{ pack: StickerPack }>(`/packs/${sel.id}`, "POST", patch);
      setSel(r.pack);
      void refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const upload = async (files: FileList | null, emoji: string) => {
    if (!sel || !files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const isJson = f.name.endsWith(".json") || f.type === "application/json";
        const body = isJson ? { emoji, lottie: await readAs(f, "text") } : { emoji, file: await readAs(f, "dataurl") };
        const r = await admin<{ pack: StickerPack }>(`/packs/${sel.id}/stickers`, "POST", body);
        setSel(r.pack);
      }
      void refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl px-4 pt-5 pb-10">
          <h1 className="mb-4 text-2xl font-bold tracking-tight">Sticker packs (admin)</h1>
          {denied ? (
            <p className="text-zinc-400">Admins only.</p>
          ) : (
            <>
              <form
                className="mb-6 grid gap-2 rounded-2xl bg-white/[0.03] p-4 sm:grid-cols-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    const r = await admin<{ pack: StickerPack }>("/packs", "POST", form);
                    setForm({ title: "", emoji: "✨", category: "", description: "", priceCents: null });
                    setSel(r.pack);
                    void refresh();
                  } catch (err) {
                    toast((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Pack title" className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-3 text-[16px] sm:text-sm" data-testid="admin-title" />
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Category (e.g. Animals)" className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-3 text-[16px] sm:text-sm" />
                <input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="Emoji" className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-3 text-[16px] sm:text-sm" />
                <PriceSelect value={form.priceCents} onChange={(v) => setForm({ ...form, priceCents: v })} />
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description" className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-3 text-[16px] sm:col-span-2 sm:text-sm" />
                <button disabled={busy} className="flex h-10 items-center justify-center gap-1.5 rounded-full bg-emerald-500 font-semibold text-on-accent sm:col-span-2" data-testid="admin-create">
                  <Plus className="h-4 w-4" /> New pack (starts as a free draft)
                </button>
              </form>

              <ul className="mb-6 divide-y divide-white/5 rounded-2xl bg-white/[0.03]">
                {packs === null && <li className="p-4 text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /></li>}
                {packs?.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => !p.builtin && open(p.id)} className={cn("flex w-full items-center justify-between gap-3 p-3 text-left", !p.builtin && "hover:bg-white/5")}>
                      <span className="min-w-0 truncate">
                        {p.emoji} <b>{p.title}</b> <span className="text-zinc-500">· {p.count} · {p.builtin ? "built-in (Noto, CC BY 4.0)" : p.published ? "published" : "draft"}</span>
                      </span>
                      <span className="shrink-0 text-sm text-zinc-400">{p.priceCents ? formatPrice(p.priceCents) : "Free"}</span>
                    </button>
                  </li>
                ))}
              </ul>

              {sel && <Editor pack={sel} busy={busy} onSave={save} onUpload={upload} onRemove={async (sid) => { try { setSel((await admin<{ pack: StickerPack }>(`/packs/${sel.id}/stickers/${sid}`, "DELETE")).pack); void refresh(); } catch (e) { toast((e as Error).message); } }} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Editor({ pack, busy, onSave, onUpload, onRemove }: { pack: StickerPack; busy: boolean; onSave: (p: Record<string, unknown>) => void; onUpload: (f: FileList | null, emoji: string) => void; onRemove: (sid: string) => void }) {
  const [emoji, setEmoji] = useState(pack.emoji);
  const [attr, setAttr] = useState({ text: pack.attribution?.text ?? "", author: pack.attribution?.author ?? "", source: pack.attribution?.source ?? "", license: pack.attribution?.license ?? "", licenseUrl: pack.attribution?.licenseUrl ?? "" });
  return (
    <section className="rounded-2xl border border-white/10 p-4" data-testid="admin-editor">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{pack.emoji} {pack.title}</h2>
        <div className="flex items-center gap-2">
          <PriceSelect value={pack.priceCents} onChange={(v) => onSave({ priceCents: v })} />
          <button type="button" onClick={() => onSave({ published: !pack.published })} className={cn("flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold", pack.published ? "bg-white/10" : "bg-emerald-500 text-on-accent")} data-testid="admin-publish">
            {pack.published ? <><EyeOff className="h-4 w-4" /> Unpublish</> : <><Eye className="h-4 w-4" /> Publish</>}
          </button>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className="h-10 w-20 rounded-xl border border-white/10 bg-zinc-900 px-3 text-center text-[16px]" aria-label="Emoji for uploaded stickers" />
        <label className="flex h-10 cursor-pointer items-center gap-1.5 rounded-full bg-white/10 px-4 text-sm font-semibold">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload stickers
          <input type="file" multiple accept="image/webp,image/png,image/gif,application/json,.json" className="hidden" onChange={(e) => { onUpload(e.target.files, emoji); e.target.value = ""; }} data-testid="admin-upload" />
        </label>
        <span className="text-[12px] text-zinc-500">WebP/PNG/GIF (≤1 MB, animated OK) or Lottie .json (≤10 s). Only upload art you own or that is openly licensed.</span>
      </div>
      <div className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-2">
        {pack.stickers.map((s) => (
          <div key={s.id} className="group relative rounded-xl bg-white/[0.03] p-1">
            <StickerView sticker={s} size={72} />
            <button type="button" onClick={() => onRemove(s.id)} className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Remove sticker">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-400">Attribution (shown on the pack page)</summary>
        <div className="mt-2 grid gap-2">
          {(["text", "author", "source", "license", "licenseUrl"] as const).map((k) => (
            <input key={k} value={attr[k]} onChange={(e) => setAttr({ ...attr, [k]: e.target.value })} placeholder={k} className="h-10 rounded-xl border border-white/10 bg-zinc-900 px-3 text-[16px] sm:text-sm" />
          ))}
          <button type="button" onClick={() => onSave({ attribution: attr })} className="h-10 rounded-full bg-white/10 font-semibold">Save attribution</button>
        </div>
      </details>
    </section>
  );
}
