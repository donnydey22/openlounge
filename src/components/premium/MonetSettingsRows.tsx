"use client";
// Settings rows for paid features (Premium, creator & business accounts). Each row appears only when its feature flag is on (and, inside the phone apps,
// only for people who already have it — no purchase entry points in the apps).
import { useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, ChevronRight, Star } from "lucide-react";
import { creatorConfig } from "@/lib/creator/client";
import { inApp, premiumConfig, premiumMe } from "@/lib/premium/client";

export function MonetSettingsRows({ signedIn }: { signedIn: boolean }) {
  const [premium, setPremium] = useState<{
    on: boolean;
    member: boolean;
  } | null>(null);
  useEffect(() => {
    let off = false;
    premiumConfig()
      .then(async (r) => {
        if (!r.config.enabled) return;
        const member = signedIn
          ? await premiumMe()
              .then((m) => m.active)
              .catch(() => false)
          : false;
        if (!off) setPremium({ on: true, member });
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [signedIn]);
  const [creatorOn, setCreatorOn] = useState(false);
  useEffect(() => {
    let off = false;
    if (signedIn)
      creatorConfig()
        .then((r) => !off && setCreatorOn(r.config.enabled))
        .catch(() => {});
    return () => {
      off = true;
    };
  }, [signedIn]);
  const showPremium = premium?.on && (premium.member || !inApp());
  if (!showPremium && !creatorOn) return null;
  return (
    <>
      {creatorOn && (
        <Link
          href="/creator"
          data-testid="settings-creator"
          className="flex items-center gap-3 border-t border-white/5 px-4 py-3 text-sm hover:bg-white/5"
        >
          <BadgeCheck className="h-4 w-4 text-sky-400" />{" "}
          <span className="flex-1">Creator &amp; business</span>
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        </Link>
      )}
      {showPremium && (
        <Link
          href="/premium"
          data-testid="settings-premium"
          className="flex items-center gap-3 border-t border-white/5 px-4 py-3 text-sm hover:bg-white/5"
        >
          <Star className="h-4 w-4 fill-amber-300 text-amber-300" />{" "}
          <span className="flex-1">
            Open Lounge Premium
            {premium?.member && (
              <span className="ml-2 text-xs text-emerald-400">Member</span>
            )}
          </span>
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        </Link>
      )}
    </>
  );
}
