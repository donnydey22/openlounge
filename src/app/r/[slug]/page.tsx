"use client";
// Branded creator/business page: openlounge.app/r/<slug> (flag CREATOR_ENABLED). Live room + upcoming series.
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, CalendarClock, Loader2, Radio } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { brandPage, type BrandPage } from "@/lib/creator/client";

export default function BrandPageView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [p, setP] = useState<BrandPage | null | false>(null);
  useEffect(() => {
    brandPage(slug).then(setP).catch(() => setP(false));
  }, [slug]);
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {p === null ? <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-zinc-500" /> : p === false ? (
          <div className="mx-auto max-w-xl px-4 pt-10 text-center" data-testid="brand-missing">
            <h1 className="text-xl font-semibold">Page not found</h1>
            <Link href="/" className="mt-4 inline-block text-emerald-400 underline">Go to the hallway</Link>
          </div>
        ) : (
          <div className="min-h-full" style={{ background: p.branding.background }} data-testid="brand-page">
            <div className="relative h-36 bg-cover bg-center sm:h-48" style={{ backgroundImage: p.branding.cover ? `url(${p.branding.cover})` : `linear-gradient(135deg, ${p.branding.accent}66, transparent)` }} />
            <div className="mx-auto -mt-10 max-w-xl px-4 pb-10">
              {p.branding.logo ? <img src={p.branding.logo} alt="" className="relative h-20 w-20 rounded-2xl border-4 object-cover" style={{ borderColor: p.branding.background }} /> : <div className="relative h-20 w-20 rounded-2xl border-4 bg-white/10" style={{ borderColor: p.branding.background }} />}
              <h1 className="mt-3 flex items-center gap-1.5 text-2xl font-bold" style={{ color: p.branding.accent }}>
                {p.branding.displayName || p.host.name}
                {p.host.verified && <BadgeCheck aria-label={p.host.verified === "business" ? "Verified business" : "Verified creator"} className={p.host.verified === "business" ? "h-6 w-6 text-amber-300" : "h-6 w-6 text-sky-400"} data-testid="brand-verified" />}
              </h1>
              <Link href={`/profile/${p.host.id}`} className="text-sm text-zinc-400 hover:underline">{p.host.username ? `@${p.host.username}` : p.host.name}</Link>
              {p.live && (
                <Link href={`/room/${p.live.id}`} className="mt-5 flex items-center gap-3 rounded-2xl p-4 text-black" style={{ background: p.branding.accent }} data-testid="brand-live">
                  <Radio className="h-5 w-5" />
                  <span className="min-w-0 flex-1"><span className="block text-xs font-semibold uppercase">Live now · {p.live.listeners} listening</span><span className="block truncate font-semibold">{p.live.title}</span></span>
                  <span className="rounded-full bg-black/80 px-3 py-1 text-sm font-semibold text-white">Join</span>
                </Link>
              )}
              <h2 className="mt-6 mb-2 text-sm font-semibold text-zinc-300">Upcoming</h2>
              {!p.upcoming.length ? <p className="text-sm text-zinc-500">No scheduled rooms yet.</p> : (
                <ul className="space-y-2">
                  {p.upcoming.map((u) => (
                    <li key={`${u.seriesId}-${u.at}`} className="flex items-center gap-3 rounded-2xl bg-white/5 p-3" data-testid="brand-upcoming">
                      <CalendarClock className="h-5 w-5 shrink-0" style={{ color: p.branding.accent }} />
                      <span className="min-w-0 flex-1 truncate font-medium">{u.title}</span>
                      <span className="shrink-0 text-xs text-zinc-400">{new Date(u.at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
