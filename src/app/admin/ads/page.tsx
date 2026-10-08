"use client";
// Ads admin hub (admins only). Sponsored rooms & highlighted ads: booking, scheduling, review queue, report (CSV).
// In-chat sponsored messages live at /admin/sponsored (same nav). Nothing is shown to people while ADS_ENABLED is off.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, Pause, Play, Plus, Send, Trash2, Check, X, Undo2 } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useApp } from "@/components/AppProvider";
import { AdsAdminNav, type AdsTab } from "@/components/ads/AdsAdminNav";
import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { AD_PLACEMENTS, type AdPlacement, type AdStatsRow, type Campaign, type CampaignStatus } from "@/lib/ads/types";

const STATUS: Record<CampaignStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-white/10 text-zinc-300" },
  pending_review: { label: "In review", cls: "bg-amber-300/20 text-amber-200" },
  approved: { label: "Approved", cls: "bg-emerald-500/20 text-emerald-300" },
  rejected: { label: "Rejected", cls: "bg-red-500/20 text-red-300" },
  paused: { label: "Paused", cls: "bg-sky-500/20 text-sky-300" },
};
const pad = (n: number) => String(n).padStart(2, "0");
const toLocal = (t: number | null) => {
  if (!t) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocal = (s: string) => (s ? new Date(s).getTime() : null);
const formatFull = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const money = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const today = (off = 0) => new Date(Date.now() - off * 86_400_000).toISOString().slice(0, 10);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await authFetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw Object.assign(new Error(j?.error || `Error ${r.status}`), { status: r.status });
  return j as T;
}

type Form = {
  advertiser: string; contact: string; kind: "room" | "card"; placements: AdPlacement[]; hostId: string; title: string; body: string;
  ctaLabel: string; ctaUrl: string; start: string; end: string; capPerDay: number; weight: number; priceCents: string; reference: string; notes: string;
  imageData?: string | null; imagePreview?: string | null;
};
const blank = (): Form => ({ advertiser: "", contact: "", kind: "room", placements: ["hallway"], hostId: "", title: "", body: "", ctaLabel: "Learn more", ctaUrl: "", start: toLocal(Date.now()), end: "", capPerDay: 3, weight: 1, priceCents: "", reference: "", notes: "" });
const fromCampaign = (c: Campaign): Form => ({
  advertiser: c.advertiser, contact: c.contact, kind: c.kind, placements: c.placements, hostId: c.hostId ?? "", title: c.title, body: c.body, ctaLabel: c.ctaLabel, ctaUrl: c.ctaUrl,
  start: toLocal(c.startsAt), end: toLocal(c.endsAt), capPerDay: c.capPerDay, weight: c.weight, priceCents: c.booking.priceCents == null ? "" : (c.booking.priceCents / 100).toFixed(2), reference: c.booking.reference, notes: c.booking.notes, imagePreview: c.image,
});
const toInput = (f: Form) => ({
  advertiser: f.advertiser, contact: f.contact, kind: f.kind, placements: f.placements, hostId: f.hostId, title: f.title, body: f.body, ctaLabel: f.ctaLabel, ctaUrl: f.ctaUrl,
  startsAt: fromLocal(f.start), endsAt: fromLocal(f.end), capPerDay: f.capPerDay, weight: f.weight,
  booking: { priceCents: f.priceCents === "" ? null : Math.round(Number(f.priceCents) * 100), reference: f.reference, notes: f.notes },
  ...(f.imageData !== undefined ? { imageData: f.imageData } : {}),
});

export default function AdsAdminPage() {
  const { toast } = useApp();
  const [tab, setTab] = useState<AdsTab>("campaigns");
  const [data, setData] = useState<{ enabled: boolean; campaigns: Campaign[] } | null>(null);
  const [denied, setDenied] = useState(false);
  const [edit, setEdit] = useState<{ id: string | null; f: Form } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<{ enabled: boolean; campaigns: Campaign[] }>("/api/admin/ads"));
    } catch (e) {
      if ((e as { status?: number }).status === 403) setDenied(true);
      else toast((e as Error).message);
    }
  }, [toast]);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "review" || t === "report") setTab(t);
    void load();
  }, [load]);

  const pending = useMemo(() => data?.campaigns.filter((c) => c.status === "pending_review") ?? [], [data]);
  const act = async (id: string, action: string, note = "") => {
    setBusy(true);
    try {
      await api("/api/admin/ads", { op: "review", id, action, note });
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: string) => {
    if (!confirm("Delete this campaign?")) return;
    try {
      await api("/api/admin/ads", { op: "delete", id });
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api("/api/admin/ads", edit.id ? { op: "update", id: edit.id, campaign: toInput(edit.f) } : { op: "create", campaign: toInput(edit.f) });
      setEdit(null);
      await load();
      toast(edit.id ? "Saved" : "Draft created. Submit it for review when ready.");
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
        <div className="mx-auto max-w-3xl px-4 pt-5 pb-[calc(4rem+env(safe-area-inset-bottom,0px))]">
          <h1 className="mb-3 text-2xl font-bold tracking-tight">Ads (admin)</h1>
          {denied ? (
            <p className="text-zinc-400">Admins only.</p>
          ) : (
            <>
              <AdsAdminNav current={tab} pending={pending.length} onPick={setTab} />
              {data && !data.enabled && (
                <p className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-[13px] text-zinc-400" data-testid="ads-off">
                  Sponsored rooms &amp; ads are <b>off</b> (ADS_ENABLED). You can book, schedule and review campaigns. Nobody sees them until the flag is on.
                </p>
              )}
              {!data ? (
                <div className="grid h-24 place-items-center text-zinc-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : tab === "report" ? (
                <Report campaigns={data.campaigns} />
              ) : (
                <>
                  {tab === "campaigns" && !edit && (
                    <button type="button" onClick={() => setEdit({ id: null, f: blank() })} data-testid="ads-new" className="mb-4 flex h-10 items-center gap-1.5 rounded-full bg-emerald-500 px-4 font-semibold text-on-accent">
                      <Plus className="h-4 w-4" /> New campaign
                    </button>
                  )}
                  {edit && <Editor form={edit.f} isNew={!edit.id} busy={busy} onChange={(f) => setEdit({ ...edit, f })} onCancel={() => setEdit(null)} onSave={save} />}
                  <ul className="space-y-3" data-testid={tab === "review" ? "review-queue" : "campaign-list"}>
                    {(tab === "review" ? pending : data.campaigns).map((c) => (
                      <li key={c.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4" data-testid="campaign" data-status={c.status}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS[c.status].cls)}>{STATUS[c.status].label}</span>
                          <b className="min-w-0 truncate">{c.advertiser}</b>
                          <span className="text-[12px] text-zinc-500">{c.kind === "room" ? "Sponsored room" : "Ad card"} · {c.placements.join(", ")}</span>
                          <span className="ml-auto text-[12px] text-zinc-500">{money(c.booking.priceCents)}{c.booking.reference && ` · ${c.booking.reference}`}</span>
                        </div>
                        <div className="mt-2 text-[15px] font-semibold">{c.title || <span className="text-zinc-500">(live room title)</span>}</div>
                        {c.body && <p className="text-sm text-zinc-400">{c.body}</p>}
                        <div className="mt-1 text-[12px] text-zinc-500">
                          {formatFull(c.startsAt)} → {c.endsAt ? formatFull(c.endsAt) : "no end"} · max {c.capPerDay}/person/day · weight {c.weight}
                          {c.review && ` · reviewed ${formatFull(c.review.at)}${c.review.note ? `: “${c.review.note}”` : ""}`}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(c.status === "draft" || c.status === "rejected") && <Btn icon={Send} onClick={() => act(c.id, "submit")} busy={busy} testid="submit">Submit for review</Btn>}
                          {c.status === "pending_review" && (
                            <>
                              <Btn icon={Check} onClick={() => act(c.id, "approve", prompt("Approval note (optional)") ?? "")} busy={busy} testid="approve" tone="ok">Approve</Btn>
                              <Btn icon={X} onClick={() => { const n = prompt("Why is it rejected? (sent back with the campaign)"); if (n) void act(c.id, "reject", n); }} busy={busy} testid="reject" tone="bad">Reject</Btn>
                              <Btn icon={Undo2} onClick={() => act(c.id, "withdraw")} busy={busy}>Back to draft</Btn>
                            </>
                          )}
                          {c.status === "approved" && <Btn icon={Pause} onClick={() => act(c.id, "pause")} busy={busy} testid="pause">Pause</Btn>}
                          {c.status === "paused" && <Btn icon={Play} onClick={() => act(c.id, "resume")} busy={busy}>Resume</Btn>}
                          {tab === "campaigns" && <Btn onClick={() => setEdit({ id: c.id, f: fromCampaign(c) })} busy={busy}>Edit</Btn>}
                          {tab === "campaigns" && c.status !== "approved" && <Btn icon={Trash2} onClick={() => del(c.id)} busy={busy} tone="bad">Delete</Btn>}
                        </div>
                      </li>
                    ))}
                    {(tab === "review" ? pending : data.campaigns).length === 0 && <li className="rounded-2xl bg-white/[0.03] p-4 text-sm text-zinc-500">{tab === "review" ? "Nothing waiting for review." : "No campaigns yet."}</li>}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Btn({ children, onClick, busy, icon: Icon, tone, testid }: { children: React.ReactNode; onClick: () => void; busy?: boolean; icon?: React.ComponentType<{ className?: string }>; tone?: "ok" | "bad"; testid?: string }) {
  return (
    <button type="button" disabled={busy} onClick={onClick} data-testid={testid} className={cn("flex h-9 items-center gap-1.5 rounded-full px-3 text-sm", tone === "ok" ? "bg-emerald-500 text-on-accent" : tone === "bad" ? "bg-red-500/15 text-red-300" : "bg-white/10 text-zinc-200")}>
      {Icon && <Icon className="h-4 w-4" />} {children}
    </button>
  );
}

const inputCls = "h-10 w-full rounded-xl border border-white/10 bg-zinc-900 px-3 text-[16px] sm:text-sm";
function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={cn("block", wide && "sm:col-span-2")}>
      <span className="mb-1 block text-[12px] text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function Editor({ form: f, isNew, busy, onChange, onCancel, onSave }: { form: Form; isNew: boolean; busy: boolean; onChange: (f: Form) => void; onCancel: () => void; onSave: () => void }) {
  const set = (p: Partial<Form>) => onChange({ ...f, ...p });
  return (
    <section className="mb-5 rounded-2xl border border-white/10 p-4" data-testid="ads-editor">
      <h2 className="mb-3 text-lg font-semibold">{isNew ? "New campaign" : "Edit campaign"}</h2>
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-zinc-500 uppercase">Booking</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Advertiser (shown as “Sponsored by …”)"><input className={inputCls} value={f.advertiser} onChange={(e) => set({ advertiser: e.target.value })} data-testid="f-advertiser" /></Field>
        <Field label="Contact (admin only)"><input className={inputCls} value={f.contact} onChange={(e) => set({ contact: e.target.value })} placeholder="name@company.com" /></Field>
        <Field label="Price (USD, admin only)"><input className={inputCls} inputMode="decimal" value={f.priceCents} onChange={(e) => set({ priceCents: e.target.value.replace(/[^\d.]/g, "") })} placeholder="250.00" /></Field>
        <Field label="Invoice / reference"><input className={inputCls} value={f.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>
        <Field label="Notes" wide><input className={inputCls} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-zinc-500 uppercase">Schedule</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Starts"><input type="datetime-local" className={inputCls} value={f.start} onChange={(e) => set({ start: e.target.value })} /></Field>
        <Field label="Ends (optional)"><input type="datetime-local" className={inputCls} value={f.end} onChange={(e) => set({ end: e.target.value })} /></Field>
        <Field label="Frequency cap (times per person per day)"><input type="number" min={1} max={50} className={inputCls} value={f.capPerDay} onChange={(e) => set({ capPerDay: Number(e.target.value) })} /></Field>
        <Field label="Weight (share vs other live campaigns)"><input type="number" min={1} max={100} className={inputCls} value={f.weight} onChange={(e) => set({ weight: Number(e.target.value) })} /></Field>
      </div>
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-zinc-500 uppercase">Creative</h3>
      <div className="mb-3 flex flex-wrap gap-2">
        {(["room", "card"] as const).map((k) => (
          <button key={k} type="button" onClick={() => set({ kind: k })} data-testid={`f-kind-${k}`} className={cn("rounded-full border px-3 py-1.5 text-sm", f.kind === k ? "border-amber-300 bg-amber-300/10" : "border-white/10")}>
            {k === "room" ? "Sponsored room (host's live room)" : "Highlighted ad card"}
          </button>
        ))}
        {AD_PLACEMENTS.map((p) => (
          <label key={p} className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-sm">
            <input type="checkbox" checked={f.placements.includes(p)} onChange={(e) => set({ placements: e.target.checked ? [...f.placements, p] : f.placements.filter((x) => x !== p) })} />
            {p === "hallway" ? "Hallway (top)" : "Explore"}
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {f.kind === "room" && <Field label="Host @username (their live room is featured)" wide><input className={inputCls} value={f.hostId} onChange={(e) => set({ hostId: e.target.value })} placeholder="@host" data-testid="f-host" /></Field>}
        <Field label={f.kind === "room" ? "Title while the host is offline (optional fallback card)" : "Title"} wide><input className={inputCls} maxLength={80} value={f.title} onChange={(e) => set({ title: e.target.value })} data-testid="f-title" /></Field>
        <Field label="Text" wide><textarea className={cn(inputCls, "h-20 py-2")} maxLength={240} value={f.body} onChange={(e) => set({ body: e.target.value })} /></Field>
        <Field label="Button label"><input className={inputCls} maxLength={24} value={f.ctaLabel} onChange={(e) => set({ ctaLabel: e.target.value })} /></Field>
        <Field label="Button link (https://)"><input className={inputCls} value={f.ctaUrl} onChange={(e) => set({ ctaUrl: e.target.value })} data-testid="f-url" /></Field>
        <Field label="Image (optional, re-encoded on upload)" wide>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const r = new FileReader();
              r.onload = () => set({ imageData: String(r.result), imagePreview: String(r.result) });
              r.readAsDataURL(file);
            }}
            className="text-sm"
          />
          {f.imagePreview && (
            <span className="mt-2 flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.imagePreview} alt="" className="h-16 rounded-lg object-cover" />
              <button type="button" className="text-sm text-red-300" onClick={() => set({ imageData: null, imagePreview: null })}>Remove</button>
            </span>
          )}
        </Field>
      </div>
      <p className="mt-3 text-[12px] text-zinc-500">Every placement is labelled “Sponsored”. Changing the creative of an approved campaign sends it back to review.</p>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={onSave} data-testid="ads-save" className="flex h-10 items-center gap-1.5 rounded-full bg-emerald-500 px-4 font-semibold text-on-accent">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {isNew ? "Create draft" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="h-10 rounded-full bg-white/10 px-4 text-sm">Cancel</button>
      </div>
    </section>
  );
}

function Report({ campaigns }: { campaigns: Campaign[] }) {
  const { toast } = useApp();
  const [from, setFrom] = useState(today(29));
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<AdStatsRow[] | null>(null);
  useEffect(() => {
    setRows(null);
    api<{ rows: AdStatsRow[] }>(`/api/admin/ads/report?from=${from}&to=${to}`).then((r) => setRows(r.rows)).catch((e) => toast((e as Error).message));
  }, [from, to, toast]);
  const byCampaign = useMemo(() => {
    const m = new Map<string, { impressions: number; clicks: number; joins: number }>();
    for (const r of rows ?? []) {
      const s = m.get(r.campaignId) ?? { impressions: 0, clicks: 0, joins: 0 };
      s.impressions += r.impressions;
      s.clicks += r.clicks;
      s.joins += r.joins;
      m.set(r.campaignId, s);
    }
    return [...m];
  }, [rows]);
  const csv = async () => {
    const r = await authFetch(`/api/admin/ads/report?from=${from}&to=${to}&format=csv`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `sponsored-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section data-testid="ads-report">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="From"><input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <button type="button" onClick={csv} data-testid="ads-csv" className="flex h-10 items-center gap-1.5 rounded-full bg-white/10 px-4 text-sm"><Download className="h-4 w-4" /> CSV</button>
      </div>
      <p className="mb-3 text-[12px] text-zinc-500">Aggregate counts only (no per-person data). Impressions are counted when the slot is served. Clicks and joins count once per person per day. CTR = (clicks + joins) / impressions.</p>
      {rows === null ? (
        <div className="grid h-16 place-items-center text-zinc-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-left text-[12px] text-zinc-400">
              <tr><th className="p-2">Campaign</th><th className="p-2 text-right">Impressions</th><th className="p-2 text-right">Clicks</th><th className="p-2 text-right">Joins</th><th className="p-2 text-right">CTR</th></tr>
            </thead>
            <tbody>
              {byCampaign.map(([id, s]) => {
                const c = campaigns.find((x) => x.id === id);
                return (
                  <tr key={id} className="border-t border-white/5">
                    <td className="p-2">{c ? `${c.advertiser} · ${c.title || "sponsored room"}` : id}</td>
                    <td className="p-2 text-right tabular-nums">{s.impressions}</td>
                    <td className="p-2 text-right tabular-nums">{s.clicks}</td>
                    <td className="p-2 text-right tabular-nums">{s.joins}</td>
                    <td className="p-2 text-right tabular-nums">{s.impressions ? `${(((s.clicks + s.joins) / s.impressions) * 100).toFixed(1)}%` : "—"}</td>
                  </tr>
                );
              })}
              {byCampaign.length === 0 && <tr><td colSpan={5} className="p-3 text-zinc-500">No data in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
