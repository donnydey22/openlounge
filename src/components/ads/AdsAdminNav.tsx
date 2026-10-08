"use client";
// One ads admin for Open Lounge: sponsored rooms & highlighted ads (/admin/ads: booking, schedule, review queue,
// report) and in-chat sponsored messages (/admin/sponsored). Both pages show this nav.
import Link from "next/link";
import { cn } from "@/lib/utils";

export type AdsTab = "campaigns" | "review" | "report" | "messages";
const TABS: { id: AdsTab; label: string; href: string }[] = [
  { id: "campaigns", label: "Rooms & ads", href: "/admin/ads" },
  { id: "review", label: "Review queue", href: "/admin/ads?tab=review" },
  { id: "report", label: "Report", href: "/admin/ads?tab=report" },
  { id: "messages", label: "In-chat messages", href: "/admin/sponsored" },
];

export function AdsAdminNav({ current, pending, onPick }: { current: AdsTab; pending?: number; onPick?: (t: AdsTab) => void }) {
  return (
    <nav className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Ads admin" data-testid="ads-admin-nav">
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          onClick={(e) => {
            if (onPick && t.id !== "messages") {
              e.preventDefault();
              window.history.replaceState(null, "", t.href);
              onPick(t.id);
            }
          }}
          aria-current={current === t.id ? "page" : undefined}
          className={cn("shrink-0 rounded-full border px-3.5 py-1.5 text-sm", current === t.id ? "border-white/80 bg-white text-on-accent" : "border-white/10 text-zinc-400 hover:text-zinc-200")}
        >
          {t.label}
          {t.id === "review" && !!pending && <span className="ml-1.5 rounded-full bg-amber-300 px-1.5 text-[11px] font-bold text-zinc-950">{pending}</span>}
        </Link>
      ))}
    </nav>
  );
}
