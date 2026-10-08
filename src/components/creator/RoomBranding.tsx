"use client";
// Branded room strip (logo, name, accent, cover) shown at the top of rooms hosted by a creator/business account
// with branding set up. Renders nothing while CREATOR_ENABLED is off or the host has no branding.
import { useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck } from "lucide-react";
import { roomBranding, type RoomBrand } from "@/lib/creator/client";

export function RoomBranding({ hostId }: { hostId: string | null | undefined }) {
  const [b, setB] = useState<RoomBrand | null>(null);
  useEffect(() => {
    let off = false;
    if (hostId) void roomBranding(hostId).then((x) => !off && setB(x));
    return () => {
      off = true;
    };
  }, [hostId]);
  if (!b || (!b.logo && !b.displayName && !b.cover)) return null;
  const inner = (
    <>
      {b.cover && <div aria-hidden className="absolute inset-0 bg-cover bg-center opacity-40" style={{ backgroundImage: `url(${b.cover})` }} />}
      <div className="relative flex items-center gap-2.5 p-2.5">
        {b.logo && <img src={b.logo} alt="" className="h-9 w-9 shrink-0 rounded-xl object-cover" />}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: b.accent }}>
          {b.displayName}
          {b.verified && <BadgeCheck aria-label={b.verified === "business" ? "Verified business" : "Verified creator"} className={`ml-1 inline h-4 w-4 align-[-3px] ${b.verified === "business" ? "text-amber-300" : "text-sky-400"}`} />}
        </span>
        {b.slug && <span className="shrink-0 text-xs text-zinc-400">openlounge.app/r/{b.slug}</span>}
      </div>
    </>
  );
  const cls = "relative mb-3 block overflow-hidden rounded-2xl border";
  const style = { borderColor: `${b.accent}55`, background: b.background };
  return b.slug ? (
    <Link href={`/r/${b.slug}`} data-testid="room-branding" className={cls} style={style}>
      {inner}
    </Link>
  ) : (
    <div data-testid="room-branding" className={cls} style={style}>
      {inner}
    </div>
  );
}
