"use client";
// Creator & business accounts (flag CREATOR_ENABLED, off by default): verification badge (ID + business checks,
// fee paid on the web through the shared PayPal checkout — never inside the phone apps), analytics, branded rooms, series.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BadgeCheck, BarChart3, Building2, CalendarClock, ChevronLeft, Loader2, Palette, Trash2, User } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useApp } from "@/components/AppProvider";
import { PayButtons } from "@/components/stickers/PayButtons";
import { loadConfig } from "@/lib/stickers/client";
import { formatPrice } from "@/lib/stickers/types";
import { inApp, invalidateBadge } from "@/lib/premium/client";
import {
  WEEKDAYS, applyVerification, creatorAnalytics, creatorConfig, creatorMe, deleteSeries, readFileAsDataUrl, saveBranding, saveSeries, setCreatorProfile, withdrawVerification, type CreatorMe,
} from "@/lib/creator/client";
import type { AccountType, CreatorAnalytics, CreatorConfig, RoomSession, Series } from "@/lib/creator/types";
import { cn } from "@/lib/utils";

const inputCls = "w-full rounded-xl border border-white/10 bg-zinc-900 px-3 py-2 text-base outline-none focus:border-emerald-400/60 sm:text-sm";
const btn = "inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50";
type Tab = "analytics" | "verify" | "branding" | "series";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export default function CreatorPage() {
  const { me: user, toast } = useApp();
  const [cfg, setCfg] = useState<CreatorConfig | null>(null);
  const [wrapper, setWrapper] = useState(false);
  const [data, setData] = useState<CreatorMe | null>(null);
  const [tab, setTab] = useState<Tab>("analytics");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    creatorConfig()
      .then((r) => {
        setCfg(r.config);
        setWrapper(r.wrapper || inApp());
        if (r.config.checkout) void loadConfig();
      })
      .catch(() => setCfg(null));
  }, []);
  const refresh = useCallback(() => {
    if (user && cfg?.enabled) creatorMe().then(setData).catch((e) => toast((e as Error).message));
  }, [user, cfg?.enabled, toast]);
  useEffect(refresh, [refresh]);

  const turnOn = async (type: AccountType) => {
    setBusy(true);
    try {
      await setCreatorProfile({ type, enabled: true });
      refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const on = !!data?.profile?.enabled;
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))]" data-testid="creator-page">
          <Link href="/settings" className="-ml-1 mb-2 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
            <ChevronLeft className="h-4 w-4" /> Settings
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">Creator &amp; business</h1>
          <p className="mt-1 text-sm text-zinc-400">Verification badge, room analytics, branded rooms and series.</p>
          {!cfg ? (
            <Loader2 className="mt-8 h-5 w-5 animate-spin text-zinc-500" />
          ) : !cfg.enabled ? (
            <p className="mt-6 rounded-2xl border border-white/10 p-4 text-sm text-zinc-300" data-testid="creator-off">Creator and business accounts are coming soon.</p>
          ) : !user ? (
            <p className="mt-6 text-sm"><Link href="/auth" className="text-emerald-400 underline">Sign in</Link> to set up a creator or business account.</p>
          ) : !data ? (
            <Loader2 className="mt-8 h-5 w-5 animate-spin text-zinc-500" />
          ) : !on ? (
            <div className="mt-6 grid gap-3 sm:grid-cols-2" data-testid="creator-choose">
              {([["creator", User, "Creator", "For hosts, podcasters and artists."], ["business", Building2, "Business", "For brands, shops and organisations."]] as const).map(([t, Icon, title, body]) => (
                <button key={t} disabled={busy} onClick={() => turnOn(t)} data-testid={`creator-turn-on-${t}`} className="rounded-2xl border border-white/10 p-4 text-left hover:border-emerald-400/50 hover:bg-white/5">
                  <Icon className="h-5 w-5 text-emerald-400" />
                  <div className="mt-2 font-semibold">{title} account</div>
                  <div className="text-sm text-zinc-400">{body}</div>
                  <div className="mt-3 text-xs text-zinc-500">Free to turn on. Verification is optional.</div>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="mt-4 flex items-center gap-2 text-sm">
                <span className="rounded-full bg-white/5 px-3 py-1 capitalize">{data.profile!.type} account</span>
                {data.verified && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sky-400/10 px-3 py-1 text-sky-300" data-testid="creator-verified">
                    <BadgeCheck className="h-4 w-4" /> Verified
                  </span>
                )}
              </div>
              <nav className="mt-4 flex gap-1 overflow-x-auto rounded-full bg-white/5 p-1 text-sm" role="tablist">
                {([["analytics", BarChart3, "Analytics"], ["verify", BadgeCheck, "Verification"], ["branding", Palette, "Branding"], ["series", CalendarClock, "Series"]] as const).map(([t, Icon, l]) => (
                  <button key={t} role="tab" aria-selected={tab === t} data-testid={`creator-tab-${t}`} onClick={() => setTab(t)} className={cn("flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5", tab === t ? "bg-zinc-800 text-white" : "text-zinc-400")}>
                    <Icon className="h-4 w-4" /> {l}
                  </button>
                ))}
              </nav>
              <div className="mt-5">
                {tab === "analytics" && <Analytics />}
                {tab === "verify" && <Verify data={data} cfg={cfg} wrapper={wrapper} onChange={refresh} userId={user.id} />}
                {tab === "branding" && <BrandingForm data={data} onChange={refresh} />}
                {tab === "series" && <SeriesPanel series={data.series} onChange={refresh} />}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------- analytics ----------
function Spark({ points, h = 40, className }: { points: [number, number][]; h?: number; className?: string }) {
  if (points.length < 2) return <div className={cn("text-xs text-zinc-500", className)}>Not enough data yet</div>;
  const maxX = Math.max(...points.map((p) => p[0])) || 1;
  const maxY = Math.max(...points.map((p) => p[1])) || 1;
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${((x / maxX) * 100).toFixed(2)},${(h - (y / maxY) * (h - 2) - 1).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className={cn("w-full", className)} style={{ height: h }} aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function Analytics() {
  const { toast } = useApp();
  const [days, setDays] = useState(30);
  const [a, setA] = useState<CreatorAnalytics | null>(null);
  useEffect(() => {
    setA(null);
    creatorAnalytics(days).then(setA).catch((e) => toast((e as Error).message));
  }, [days, toast]);
  if (!a) return <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />;
  const t = a.totals;
  const fol = a.followers;
  const growth = fol.length ? fol[fol.length - 1].followers - fol[0].followers : 0;
  const cards: [string, string][] = [
    ["Rooms", String(t.rooms)],
    ["Listeners", String(t.listeners)],
    ["Peak concurrency", String(t.peak)],
    ["Listening minutes", String(t.listenerMinutes)],
    ["Avg. listen", `${t.avgListenMin} min`],
    ["Replays", String(t.replays)],
  ];
  return (
    <div className="space-y-5" data-testid="creator-analytics">
      <div className="flex gap-1 text-xs">
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => setDays(d)} className={cn("rounded-full px-3 py-1", d === days ? "bg-emerald-500 text-black" : "bg-white/5 text-zinc-300")}>{d} days</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {cards.map(([l, v]) => (
          <div key={l} className="rounded-2xl bg-white/5 p-3">
            <div className="text-xs text-zinc-400">{l}</div>
            <div className="text-xl font-bold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      <section className="rounded-2xl bg-white/5 p-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-semibold">Followers</span>
          <span className="text-xs text-zinc-400">{fol.length ? `${fol[fol.length - 1].followers} · ${growth >= 0 ? "+" : ""}${growth} in ${days} days` : "—"}</span>
        </div>
        <Spark points={fol.map((f, i) => [i, f.followers])} className="mt-2 text-emerald-400" />
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">Rooms</h2>
        {!a.sessions.length && <p className="text-sm text-zinc-500">Host a room and its numbers show up here (listeners, peak, retention).</p>}
        <ul className="space-y-2">
          {a.sessions.map((s) => <SessionRow key={s.id} s={s} />)}
        </ul>
        {!a.sessions.length ? null : <p className="mt-2 text-xs text-zinc-500">Retention: share of listeners still in the room 5/15/30/60 minutes after they joined. Counts only — no listener lists are kept.</p>}
      </section>
    </div>
  );
}
function SessionRow({ s }: { s: RoomSession }) {
  const dur = Math.max(1, Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 60_000));
  return (
    <li className="rounded-2xl border border-white/10 p-3" data-testid="creator-session">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">{s.title || "Room"}</span>
        <span className="shrink-0 text-xs text-zinc-500">{new Date(s.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {dur} min{s.endedAt ? "" : " · live"}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-zinc-400">
        <span>{plural(s.uniqueListeners, "listener")}</span><span>peak {s.peak}</span><span>{Math.round(s.listenerMinutes)} listening min</span>{s.replays > 0 && <span>{plural(s.replays, "replay")}</span>}
      </div>
      <Spark points={s.curve} h={28} className="mt-2 text-sky-400" />
      <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[11px] text-zinc-400">
        {(["m5", "m15", "m30", "m60"] as const).map((k) => (
          <div key={k}>
            <div className="h-1.5 overflow-hidden rounded bg-white/10"><div className="h-full bg-emerald-400" style={{ width: `${Math.round((s.retention[k] ?? 0) * 100)}%` }} /></div>
            {k.slice(1)}m {pct(s.retention[k])}
          </div>
        ))}
      </div>
    </li>
  );
}

// ---------- verification ----------
const COUNTRIES = "US GB CA AU IN DE FR ES IT NL SE NO DK FI IE NZ SG AE ZA BR MX JP KR PH NG KE PK BD ID MY TR PL PT BE CH AT".split(" ");
function Verify({ data, cfg, wrapper, onChange, userId }: { data: CreatorMe; cfg: CreatorConfig; wrapper: boolean; onChange: () => void; userId: string }) {
  const { toast } = useApp();
  const r = data.request;
  const [kind, setKind] = useState<AccountType>(data.profile?.type ?? "creator");
  const [f, setF] = useState({ legalName: "", businessName: "", website: "", country: "US" });
  const [idDoc, setIdDoc] = useState<File | null>(null);
  const [bizDoc, setBizDoc] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fee = cfg.fees[kind];

  if (data.verified)
    return (
      <div className="rounded-2xl bg-sky-400/10 p-4 text-sm" data-testid="verify-done">
        <BadgeCheck className="mb-1 h-6 w-6 text-sky-400" /> You&apos;re a verified {data.verified}. The badge shows next to your name.
      </div>
    );
  if (r && (r.status === "pending" || r.status === "awaiting_payment")) {
    const withdraw = async () => {
      setBusy(true);
      try {
        await withdrawVerification();
        onChange();
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="space-y-4" data-testid="verify-status">
        <div className="rounded-2xl border border-white/10 p-4 text-sm">
          <div className="font-semibold">{r.status === "pending" ? "In review" : "Waiting for the verification fee"}</div>
          <p className="mt-1 text-zinc-400">
            {r.status === "pending" ? "We check your documents, usually within a few days. They're deleted as soon as we've decided." : `${r.kind === "business" ? "Business" : "Creator"} verification · ${formatPrice(r.feeCents, "USD")} one-time. Refunded if we can't verify you.`}
          </p>
        </div>
        {r.status === "awaiting_payment" &&
          (wrapper ? (
            <p className="rounded-2xl bg-white/5 p-4 text-sm text-zinc-300" data-testid="verify-no-pay-in-app">The verification fee can&apos;t be paid in the app.</p>
          ) : cfg.checkout ? (
            <div data-testid="verify-pay">
              <PayButtons
                pack={{ id: `verify:${r.kind}:${r.id}`, title: "Verification", priceCents: r.feeCents, currency: "USD", label: `Open Lounge ${r.kind} verification` }}
                onPaid={() => {
                  toast("Paid — your request is in review");
                  invalidateBadge(userId);
                  onChange();
                }}
              />
            </div>
          ) : (
            <p className="text-sm text-zinc-400">Payments aren&apos;t available right now.</p>
          ))}
        {r.status === "awaiting_payment" && <button disabled={busy} onClick={withdraw} className={cn(btn, "bg-white/5 text-zinc-300")} data-testid="verify-withdraw">Withdraw request</button>}
      </div>
    );
  }
  const submit = async () => {
    if (!idDoc) return toast("Add a photo or scan of your ID");
    if (kind === "business" && !bizDoc) return toast("Add your business registration document");
    if ([idDoc, bizDoc].some((x) => x && x.size > 8 * 1024 * 1024)) return toast("Files must be under 8 MB");
    setBusy(true);
    try {
      await applyVerification({ kind, ...f, idDoc: await readFileAsDataUrl(idDoc), businessDoc: bizDoc ? await readFileAsDataUrl(bizDoc) : undefined });
      onChange();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="verify-form">
      {r && (r.status === "rejected" || r.status === "revoked") && (
        <p className="rounded-2xl bg-rose-500/10 p-3 text-sm text-rose-200">Your last request was {r.status}{r.note ? `: ${r.note}` : "."} You can apply again.</p>
      )}
      <p className="text-sm text-zinc-400">
        Get a {kind === "business" ? "gold" : "blue"} check next to your name. We confirm your identity{kind === "business" ? " and your business registration" : ""}.{" "}
        {cfg.feeWaived ? "No fee right now." : `${formatPrice(fee, "USD")} one-time${wrapper ? "" : ", paid with PayPal after you submit"}.`}
      </p>
      <div className="flex gap-2">
        {(["creator", "business"] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={cn(btn, "capitalize", kind === k ? "bg-emerald-500 text-black" : "bg-white/5 text-zinc-300")}>{k}</button>
        ))}
      </div>
      <Field label="Legal name (as on your ID)"><input className={inputCls} value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} autoComplete="name" data-testid="verify-legal-name" /></Field>
      {kind === "business" && <Field label="Registered business name"><input className={inputCls} value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} autoComplete="organization" /></Field>}
      <Field label="Website (optional)"><input className={inputCls} value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://" inputMode="url" /></Field>
      <Field label="Country">
        <select className={inputCls} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>
          {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Government ID (photo or PDF, under 8 MB)" hint="Only reviewers see it, and it's deleted once we decide.">
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setIdDoc(e.target.files?.[0] ?? null)} className="block w-full text-sm" data-testid="verify-id-doc" />
      </Field>
      {kind === "business" && (
        <Field label="Business registration (photo or PDF)">
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setBizDoc(e.target.files?.[0] ?? null)} className="block w-full text-sm" data-testid="verify-biz-doc" />
        </Field>
      )}
      <button disabled={busy} onClick={submit} className={cn(btn, "bg-emerald-500 text-black")} data-testid="verify-submit">
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Submit for review
      </button>
    </div>
  );
}

// ---------- branding ----------
function BrandingForm({ data, onChange }: { data: CreatorMe; onChange: () => void }) {
  const { toast } = useApp();
  const b = data.branding;
  const [f, setF] = useState({ slug: b?.slug ?? "", displayName: b?.displayName ?? "", accent: b?.accent ?? "#10B981", background: b?.background ?? "#0B0B0D", coHosts: (b?.coHosts ?? []).join(", ") });
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [cover, setCover] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const logoUrl = logo === undefined ? b?.logo : logo;
  const coverUrl = cover === undefined ? b?.cover : cover;
  const pick = (set: (v: string) => void) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast("Images must be under 5 MB");
    set(await readFileAsDataUrl(file));
  };
  const save = async () => {
    setBusy(true);
    try {
      await saveBranding({ ...f, coHosts: f.coHosts.split(/[\s,]+/).filter(Boolean), ...(logo !== undefined && { logoData: logo }), ...(cover !== undefined && { coverData: cover }) });
      toast("Branding saved");
      setLogo(undefined);
      setCover(undefined);
      onChange();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="branding-form">
      <div className="relative overflow-hidden rounded-2xl border" style={{ borderColor: `${f.accent}55`, background: f.background }} data-testid="branding-preview">
        {coverUrl && <div aria-hidden className="absolute inset-0 bg-cover bg-center opacity-40" style={{ backgroundImage: `url(${coverUrl})` }} />}
        <div className="relative flex items-center gap-3 p-4">
          {logoUrl ? <img src={logoUrl} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <div className="h-12 w-12 rounded-xl bg-white/10" />}
          <div className="min-w-0">
            <div className="truncate font-semibold" style={{ color: f.accent }}>{f.displayName || "Your brand"}</div>
            <div className="text-xs text-zinc-400">openlounge.app/r/{f.slug || "your-link"}</div>
          </div>
        </div>
      </div>
      <Field label="Display name"><input className={inputCls} value={f.displayName} maxLength={60} onChange={(e) => setF({ ...f, displayName: e.target.value })} data-testid="branding-name" /></Field>
      <Field label="Custom link" hint="3–30 letters, numbers or dashes.">
        <div className="flex items-center gap-1"><span className="text-sm text-zinc-500">openlounge.app/r/</span><input className={inputCls} value={f.slug} maxLength={30} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} data-testid="branding-slug" /></div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Accent color"><input type="color" value={f.accent} onChange={(e) => setF({ ...f, accent: e.target.value })} className="h-10 w-full rounded-xl bg-transparent" /></Field>
        <Field label="Background"><input type="color" value={f.background} onChange={(e) => setF({ ...f, background: e.target.value })} className="h-10 w-full rounded-xl bg-transparent" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Logo (square)">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pick(setLogo)} className="block w-full text-sm" data-testid="branding-logo" />
          {logoUrl && <button className="text-xs text-zinc-400 underline" onClick={() => setLogo(null)}>Remove</button>}
        </Field>
        <Field label="Cover (wide)">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pick(setCover)} className="block w-full text-sm" />
          {coverUrl && <button className="text-xs text-zinc-400 underline" onClick={() => setCover(null)}>Remove</button>}
        </Field>
      </div>
      <Field label="Co-hosts" hint="@usernames who can co-host your rooms, separated by commas."><input className={inputCls} value={f.coHosts} onChange={(e) => setF({ ...f, coHosts: e.target.value })} placeholder="@maya, @sam" /></Field>
      <div className="flex items-center gap-3">
        <button disabled={busy} onClick={save} className={cn(btn, "bg-emerald-500 text-black")} data-testid="branding-save">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save branding</button>
        {b?.slug && <Link href={`/r/${b.slug}`} className="text-sm text-emerald-400 underline" data-testid="branding-open">Open page</Link>}
      </div>
    </div>
  );
}

// ---------- series ----------
const blank = (): Partial<Series> => ({ title: "", description: "", weekdays: [], time: "19:00", tz: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC", durationMin: 60, active: true });
function SeriesPanel({ series, onChange }: { series: Series[]; onChange: () => void }) {
  const { toast } = useApp();
  const [edit, setEdit] = useState<Partial<Series> | null>(null);
  const sorted = useMemo(() => [...series].sort((a, b) => a.createdAt - b.createdAt), [series]);
  const save = async () => {
    if (!edit) return;
    try {
      await saveSeries(edit);
      setEdit(null);
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this series?")) return;
    try {
      await deleteSeries(id);
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="space-y-3" data-testid="series-panel">
      <p className="text-sm text-zinc-400">Recurring shows appear on your page as upcoming rooms.</p>
      {sorted.map((s) => (
        <div key={s.id} className="flex items-center gap-3 rounded-2xl border border-white/10 p-3" data-testid="series-row">
          <CalendarClock className="h-5 w-5 shrink-0 text-emerald-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{s.title}{!s.active && <span className="ml-2 text-xs text-zinc-500">paused</span>}</div>
            <div className="text-xs text-zinc-400">{s.weekdays.map((d) => WEEKDAYS[d]).join(", ")} · {s.time} ({s.tz}) · {s.durationMin} min</div>
          </div>
          <button onClick={() => setEdit(s)} className="text-sm text-zinc-300 underline">Edit</button>
          <button onClick={() => remove(s.id)} aria-label="Delete series" className="text-zinc-500 hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      {edit ? (
        <div className="space-y-3 rounded-2xl bg-white/5 p-4" data-testid="series-form">
          <Field label="Title"><input className={inputCls} value={edit.title} maxLength={80} onChange={(e) => setEdit({ ...edit, title: e.target.value })} data-testid="series-title" /></Field>
          <Field label="Description"><input className={inputCls} value={edit.description} maxLength={300} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((w, i) => {
              const sel = edit.weekdays?.includes(i);
              return (
                <button key={w} onClick={() => setEdit({ ...edit, weekdays: sel ? edit.weekdays!.filter((x) => x !== i) : [...(edit.weekdays ?? []), i] })} className={cn("rounded-full px-3 py-1 text-xs", sel ? "bg-emerald-500 text-black" : "bg-white/5 text-zinc-300")} data-testid={`series-day-${i}`}>{w}</button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Time"><input type="time" className={inputCls} value={edit.time} onChange={(e) => setEdit({ ...edit, time: e.target.value })} /></Field>
            <Field label="Length (min)"><input className={inputCls} inputMode="numeric" value={edit.durationMin} onChange={(e) => setEdit({ ...edit, durationMin: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></Field>
          </div>
          <Field label="Time zone"><input className={inputCls} value={edit.tz} onChange={(e) => setEdit({ ...edit, tz: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
          <div className="flex gap-2">
            <button onClick={save} className={cn(btn, "bg-emerald-500 text-black")} data-testid="series-save">Save</button>
            <button onClick={() => setEdit(null)} className={cn(btn, "bg-white/5 text-zinc-300")}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setEdit(blank())} className={cn(btn, "bg-white/5 text-zinc-200")} data-testid="series-new">New series</button>
      )}
    </div>
  );
}
