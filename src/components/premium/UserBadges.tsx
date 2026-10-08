"use client";
// Badges next to a name: Premium (★) and verified creator/business (✓). Renders nothing for most people,
// and nothing at all while Premium / creator accounts are switched off (the API returns no badges).
import Link from "next/link";
import { BadgeCheck, Star } from "lucide-react";
import { useBadges } from "@/lib/premium/client";
import { cn } from "@/lib/utils";

export function UserBadges({ userId, size = 16, className }: { userId: string | null | undefined; size?: number; className?: string }) {
  const b = useBadges(userId);
  if (!b.premium && !b.verified) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle", className)} data-testid="user-badges">
      {b.verified && (
        <span title={b.verified === "business" ? "Verified business" : "Verified creator"} aria-label={b.verified === "business" ? "Verified business" : "Verified creator"} data-testid="verified-badge">
          <BadgeCheck style={{ width: size, height: size }} className={b.verified === "business" ? "text-amber-300" : "text-sky-400"} />
        </span>
      )}
      {b.premium && (
        <Link href="/premium" title="Open Lounge Premium" aria-label="Open Lounge Premium member" data-testid="premium-badge" className="inline-flex">
          <Star style={{ width: size, height: size }} className="fill-amber-300 text-amber-300" />
        </Link>
      )}
    </span>
  );
}
