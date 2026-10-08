"use client";
// Featured "Sponsored" slot (hallway top / Explore). Sponsored rooms show as a room card labelled Sponsored; ad cards
// show a highlighted card. Renders nothing while ADS_ENABLED is off. No tracking SDKs, no cookies: the server counts
// the impression when it hands out the slot; a tap sends one aggregate click/join count.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone, Users } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { Avatar } from "@/components/Avatar";
import { openLinkConfirm } from "@/components/chat/LinkConfirm";
import { linkify, type LinkToken } from "@/lib/linkify";
import { unlockAudio } from "@/lib/audioUnlock";
import { cn } from "@/lib/utils";
import type { AdPlacement, AdView } from "@/lib/ads/types";

const cache = new Map<AdPlacement, { at: number; ad: AdView | null }>();

function event(ad: AdView, type: "click" | "join") {
  authFetch("/api/ads/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ad.id, placement: ad.placement, type }) }).catch(() => {});
}

export function FeaturedSponsored({ placement, className }: { placement: AdPlacement; className?: string }) {
  const [ad, setAd] = useState<AdView | null>(() => cache.get(placement)?.ad ?? null);
  useEffect(() => {
    const c = cache.get(placement);
    if (c && Date.now() - c.at < 120_000) return;
    let off = false;
    authFetch(`/api/ads/slot?placement=${placement}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ad?: AdView | null } | null) => {
        cache.set(placement, { at: Date.now(), ad: j?.ad ?? null });
        if (!off) setAd(j?.ad ?? null);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [placement]);
  if (!ad) return null;

  const label = (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-300/15 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-amber-300 uppercase" data-testid="sponsored-label">
      <Megaphone className="h-3 w-3" /> Sponsored
    </span>
  );

  if (ad.room) {
    const r = ad.room;
    return (
      <Link
        href={`/room/${r.id}`}
        onClick={() => {
          unlockAudio();
          event(ad, "join");
        }}
        data-testid="featured-sponsored"
        data-kind="room"
        className={cn("block rounded-3xl border border-amber-300/30 bg-amber-300/[0.05] p-5 transition hover:-translate-y-0.5", className)}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          {label}
          <span className="truncate text-xs text-zinc-500">{ad.advertiser}</span>
        </div>
        <h3 className="text-lg leading-snug font-semibold text-zinc-50 [overflow-wrap:anywhere]">{r.title || ad.title}</h3>
        {ad.body && <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{ad.body}</p>}
        <div className="mt-3 flex items-center gap-3">
          <div className="flex -space-x-2">
            {r.speakers.slice(0, 3).map((s) => (
              <Avatar key={s.id} name={s.name} color={s.color} photo={s.photoUrl} size="xs" />
            ))}
          </div>
          <span className="flex items-center gap-1 text-sm text-zinc-400">
            <Users className="h-4 w-4" /> {r.speakerCount + r.listenerCount} · with {r.hostName}
          </span>
          <span className="ml-auto rounded-full bg-amber-300 px-3 py-1 text-sm font-semibold text-zinc-950">Join</span>
        </div>
      </Link>
    );
  }

  const open = () => {
    const t = linkify(ad.ctaUrl).find((x): x is LinkToken => x.type === "link");
    event(ad, "click");
    if (t) openLinkConfirm(t);
  };
  return (
    <div data-testid="featured-sponsored" data-kind="card" className={cn("rounded-3xl border border-amber-300/30 bg-amber-300/[0.05] p-4", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        {label}
        <span className="truncate text-xs text-zinc-500">{ad.advertiser}</span>
      </div>
      <div className="text-[15px] leading-snug font-semibold text-zinc-50 [overflow-wrap:anywhere]">{ad.title}</div>
      {ad.body && <p className="mt-1 text-sm leading-relaxed text-zinc-300 [overflow-wrap:anywhere]">{ad.body}</p>}
      {ad.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ad.image} alt="" loading="lazy" decoding="async" className="mt-3 max-h-72 w-full rounded-2xl object-cover" />
      )}
      {ad.ctaUrl && (
        <button type="button" onClick={open} className="mt-3 flex h-11 w-full items-center justify-center rounded-2xl bg-amber-300/15 text-sm font-semibold text-amber-200 hover:bg-amber-300/25">
          {ad.ctaLabel || "Learn more"}
        </button>
      )}
    </div>
  );
}
