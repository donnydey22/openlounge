"use client";
// Open Lounge Premium. Web checkout only (PayPal, incl. Apple Pay / Google Pay via PayPal) through the shared
// sticker pipeline; the phone apps never show buy buttons or purchase links (App Store 3.1.1 / Play Payments).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Check, ChevronLeft, Clock, FileUp, Loader2, Lock, Smartphone, Sparkles, Star, Sticker } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useApp } from "@/components/AppProvider";
import { PayButtons } from "@/components/stickers/PayButtons";
import { loadConfig } from "@/lib/stickers/client";
import { formatPrice } from "@/lib/stickers/types";
import { applyAppIcon, cancelSubscription, inApp, invalidateBadge, premiumConfig, premiumMe, savePrefs, subscribe, syncSubscription } from "@/lib/premium/client";
import type { PremiumConfig, PremiumMe, PremiumPlan } from "@/lib/premium/types";
import { cn } from "@/lib/utils";

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

export default function PremiumPage() {
  const { me: user, toast } = useApp();
  const [cfg, setCfg] = useState<PremiumConfig | null>(null);
  const [wrapper, setWrapper] = useState(false);
  const [me, setMe] = useState<PremiumMe | null>(null);
  const [plan, setPlan] = useState<PremiumPlan>("year");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (user) premiumMe().then(setMe).catch(() => {});
  }, [user]);
  useEffect(() => {
    premiumConfig()
      .then((r) => {
        setCfg(r.config);
        setWrapper(r.wrapper || inApp());
        if (r.config.checkout) void loadConfig();
      })
      .catch(() => setCfg(null));
  }, []);
  useEffect(refresh, [refresh]);
  // back from PayPal's subscription approval page
  useEffect(() => {
    if (!user) return;
    const q = new URLSearchParams(window.location.search);
    const sid = q.get("subscription_id");
    if (q.get("sub") === "return" && sid) {
      setBusy("sync");
      syncSubscription(sid)
        .then((m) => {
          setMe(m);
          toast(m.active ? "Welcome to Open Lounge Premium" : "Waiting for PayPal to confirm…");
          invalidateBadge(user.id);
        })
        .catch((e) => toast((e as Error).message))
        .finally(() => setBusy(null));
      window.history.replaceState(null, "", "/premium");
    } else if (q.get("sub") === "cancel") window.history.replaceState(null, "", "/premium");
  }, [user, toast]);

  const enabled = !!cfg?.enabled;
  const perks = [
    { icon: Sticker, title: "Exclusive sticker packs", body: "Premium-only packs, included while you're a member." },
    { icon: Star, title: "Premium badge", body: "A star next to your name. You can hide it." },
    { icon: FileUp, title: "Bigger uploads", body: `Send files up to ${cfg?.premium.uploadMaxMB ?? 200} MB (free: ${cfg?.free.uploadMaxMB ?? 25} MB).` },
    { icon: Clock, title: "Longer expiring files", body: `Keep expiring files up to ${Math.max(...(cfg?.premium.fileExpiryDays ?? [90]))} days (free: ${Math.max(...(cfg?.free.fileExpiryDays ?? [7]))}).` },
    { icon: Smartphone, title: "Custom app icons", body: "Pick a color for your Open Lounge icon." },
    { icon: Sparkles, title: "Early features", body: "Try new things before everyone else." },
  ];
  const price = cfg ? cfg.prices[plan] : 0;
  const perMonthYear = cfg ? formatPrice(Math.round(cfg.prices.year / 12), cfg.currency) : "";
  const label = `Open Lounge Premium (${plan === "year" ? "1 year" : "1 month"})`;

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))]">
          <Link href="/settings" className="-ml-1 mb-2 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
            <ChevronLeft className="h-4 w-4" /> Settings
          </Link>
          <div className="rounded-3xl bg-gradient-to-br from-amber-300/20 via-emerald-400/10 to-transparent p-6">
            <div className="flex items-center gap-2 text-amber-300">
              <Star className="h-6 w-6 fill-amber-300" />
              <span className="text-[13px] font-semibold tracking-wide uppercase">Premium</span>
            </div>
            <h1 className="mt-2 text-[28px] leading-tight font-bold tracking-tight">Open Lounge Premium</h1>
            <p className="mt-1 text-[15px] text-zinc-300">More stickers, bigger files, your own icon, and new features first.</p>
            {me?.active && me.endsAt && (
              <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-300" data-testid="premium-active">
                <BadgeCheck className="h-4 w-4" /> Member{me.autoRenew ? ` · renews automatically` : ` until ${fmtDate(me.endsAt)}`}
              </div>
            )}
          </div>

          <ul className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="premium-perks">
            {perks.map((p) => (
              <li key={p.title} className="flex gap-3 rounded-2xl bg-white/[0.03] p-4">
                <p.icon className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                <div>
                  <div className="font-semibold">{p.title}</div>
                  <div className="text-[13px] text-zinc-400">{p.body}</div>
                </div>
              </li>
            ))}
          </ul>

          {cfg === null ? (
            <div className="grid h-24 place-items-center text-zinc-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : !enabled ? (
            <p className="mt-4 rounded-2xl bg-white/[0.03] p-4 text-center text-sm text-zinc-400" data-testid="premium-soon">Premium is coming soon.</p>
          ) : wrapper ? (
            // phone apps: status only, no purchase UI or links
            !me?.active && <p className="mt-4 rounded-2xl bg-white/[0.03] p-4 text-center text-sm text-zinc-400" data-testid="premium-app-note">Premium isn&apos;t available in the app.</p>
          ) : !user ? (
            <Link href="/" className="mt-4 block rounded-full bg-emerald-500 py-3 text-center font-semibold text-on-accent">Sign in to get Premium</Link>
          ) : (
            <section className="mt-4 rounded-2xl bg-white/[0.03] p-4" data-testid="premium-buy">
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Plan">
                {(["month", "year"] as PremiumPlan[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={plan === p}
                    data-testid={`plan-${p}`}
                    onClick={() => setPlan(p)}
                    className={cn("rounded-2xl border p-3 text-left", plan === p ? "border-amber-300 bg-amber-300/10" : "border-white/10 hover:bg-white/5")}
                  >
                    <div className="text-[13px] text-zinc-400">{p === "year" ? "Yearly" : "Monthly"}</div>
                    <div className="text-lg font-bold">{formatPrice(cfg.prices[p], cfg.currency)}</div>
                    <div className="text-[12px] text-zinc-500">{p === "year" ? `${perMonthYear}/month` : "per month"}</div>
                  </button>
                ))}
              </div>
              {me?.active && <p className="mt-3 text-[13px] text-zinc-400">Buying more adds time after {me.endsAt ? fmtDate(me.endsAt) : "your current period"}.</p>}
              {cfg.subscriptions.includes(plan) && !me?.autoRenew && (
                <button
                  type="button"
                  disabled={!!busy}
                  data-testid="subscribe-btn"
                  onClick={async () => {
                    setBusy("sub");
                    try {
                      const r = await subscribe(plan);
                      if (r.approveUrl) window.location.href = r.approveUrl;
                    } catch (e) {
                      toast((e as Error).message);
                      setBusy(null);
                    }
                  }}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-amber-300 py-3 font-semibold text-zinc-950 hover:bg-amber-200"
                >
                  {busy === "sub" && <Loader2 className="h-4 w-4 animate-spin" />} Subscribe with PayPal · renews {plan === "year" ? "yearly" : "monthly"}
                </button>
              )}
              {cfg.checkout && (
                <div className="mt-3">
                  {cfg.subscriptions.includes(plan) && <div className="mb-2 text-center text-[12px] text-zinc-500">or pay once, no renewal</div>}
                  <PayButtons
                    pack={{ id: `premium:${plan}`, title: label, label, priceCents: price, currency: cfg.currency }}
                    onPaid={() => {
                      toast("Welcome to Open Lounge Premium");
                      refresh();
                      invalidateBadge(user.id);
                    }}
                  />
                </div>
              )}
              <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
                One-time passes don&apos;t renew. Subscriptions renew until you cancel; cancel any time here and keep Premium until the paid period ends. Refunds follow
                our <Link href="/terms" className="underline">Terms</Link>. <Link href="/stickers/receipts" className="underline">Purchases &amp; receipts</Link>
              </p>
              {me?.autoRenew && (
                <button
                  type="button"
                  disabled={!!busy}
                  data-testid="cancel-sub"
                  onClick={async () => {
                    if (!confirm("Cancel auto-renew? You keep Premium until the end of the paid period.")) return;
                    setBusy("cancel");
                    try {
                      setMe(await cancelSubscription());
                      toast("Auto-renew cancelled");
                    } catch (e) {
                      toast((e as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                  className="mt-3 w-full rounded-full bg-white/5 py-2.5 text-sm text-zinc-300 hover:bg-white/10"
                >
                  Cancel auto-renew
                </button>
              )}
            </section>
          )}

          {enabled && user && me && (
            <section className="mt-6" data-testid="premium-settings">
              <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-zinc-400 uppercase">App icon</h2>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {cfg!.icons.map((i) => {
                  const locked = i.premium && !me.active;
                  const sel = me.prefs.appIcon === i.id;
                  return (
                    <button
                      key={i.id}
                      type="button"
                      disabled={locked || busy === "icon"}
                      data-testid={`icon-${i.id}`}
                      aria-pressed={sel}
                      onClick={async () => {
                        setBusy("icon");
                        try {
                          const m = await savePrefs({ appIcon: i.id });
                          setMe(m);
                          applyAppIcon(i.id);
                        } catch (e) {
                          toast((e as Error).message);
                        } finally {
                          setBusy(null);
                        }
                      }}
                      className={cn("relative flex flex-col items-center gap-1 rounded-2xl p-2", sel ? "bg-white/10 ring-2 ring-amber-300" : "hover:bg-white/5", locked && "opacity-50")}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/app-icons/${i.id}-180.png`} alt="" width={56} height={56} className="h-14 w-14 rounded-[22%]" loading="lazy" />
                      <span className="text-[12px] text-zinc-300">{i.name}</span>
                      {locked && <Lock className="absolute top-2 right-2 h-3.5 w-3.5 text-zinc-300" />}
                      {sel && <Check className="absolute top-2 right-2 h-3.5 w-3.5 text-amber-300" />}
                    </button>
                  );
                })}
              </div>
              {me.active && (
                <label className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-white/[0.03] p-4">
                  <span>
                    <span className="block font-semibold">Show Premium badge</span>
                    <span className="text-[13px] text-zinc-400">A star next to your name on your profile.</span>
                  </span>
                  <input
                    type="checkbox"
                    data-testid="badge-toggle"
                    className="h-5 w-5 accent-amber-300"
                    checked={me.prefs.badgeVisible}
                    onChange={async (e) => {
                      try {
                        setMe(await savePrefs({ badgeVisible: e.target.checked }));
                        invalidateBadge(user.id);
                      } catch (err) {
                        toast((err as Error).message);
                      }
                    }}
                  />
                </label>
              )}
              {me.active && cfg!.early.length > 0 && (
                <>
                  <h2 className="mt-6 mb-2 text-[13px] font-semibold tracking-wide text-zinc-400 uppercase">Early features</h2>
                  <ul className="divide-y divide-white/5 rounded-2xl bg-white/[0.03]" data-testid="early-features">
                    {cfg!.early.map((f) => (
                      <li key={f.id} className="p-4">
                        <div className="font-semibold">{f.name}</div>
                        <div className="text-[13px] text-zinc-400">{f.description}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
