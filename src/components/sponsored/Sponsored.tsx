"use client";

// Telegram-style sponsored message. One per view at most, only where an admin enabled it (bottom of the room list,
// large groups), never in 1:1 DMs. No tracking: the card makes one same-origin request for the slot and nothing is
// reported back on view or click. The CTA goes through the normal external-link confirm sheet.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Flag, Info, MoreVertical } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { linkify, type LinkToken } from "@/lib/linkify";
import { cn } from "@/lib/utils";
import { Sheet } from "@/components/Sheet";
import { openLinkConfirm } from "@/components/chat/LinkConfirm";
import { AvatarPhoto } from "@/components/AvatarPhoto";
import { useApp } from "@/components/AppProvider";

export type SponsoredAd = {
  id: string;
  advertiser: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  avatar: string | null;
  image: { src: string; w: number; h: number } | null;
};

const REASONS: { id: string; label: string }[] = [
  { id: "misleading", label: "Misleading" },
  { id: "scam", label: "Scam or fraud" },
  { id: "offensive", label: "Offensive" },
  { id: "irrelevant", label: "Not relevant" },
  { id: "other", label: "Something else" },
];

const hiddenNow = new Set<string>(); // instant hide across mounted slots before the server round-trip lands
const slotCache = new Map<string, { at: number; ad: SponsoredAd | null }>();

function ctaToken(url: string): LinkToken | null {
  const t = linkify(url).find((x): x is LinkToken => x.type === "link");
  return t ?? null;
}

export function SponsoredCard({ ad, onHidden, className }: { ad: SponsoredAd; onHidden?: () => void; className?: string }) {
  const { toast } = useApp();
  const [menu, setMenu] = useState(false);
  const [why, setWhy] = useState(false);
  const [report, setReport] = useState(false);
  const [busy, setBusy] = useState(false);

  const feedback = async (action: "hide" | "report", reason?: string) => {
    setBusy(true);
    hiddenNow.add(ad.id);
    slotCache.clear();
    onHidden?.();
    try {
      await authFetch("/sp/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ad.id, action, reason }) });
    } catch {
      /* hidden locally anyway */
    }
    setBusy(false);
    toast(action === "report" ? "Thanks — reported and hidden" : "Sponsored message hidden");
  };

  const open = () => {
    const t = ctaToken(ad.ctaUrl);
    if (t) openLinkConfirm(t);
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border border-emerald-400/20 border-l-[3px] border-l-emerald-400/80 bg-emerald-500/[0.06] p-4",
        className,
      )}
      data-sponsored={ad.id}
    >
      <div className="mb-2 flex items-center gap-2.5">
        <div className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[38%] bg-zinc-800 text-xs font-semibold text-zinc-300">
          {ad.avatar ? <AvatarPhoto src={ad.avatar} name={ad.advertiser} /> : ad.advertiser.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-emerald-300">{ad.advertiser}</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Sponsored</div>
        </div>
        <button
          type="button"
          onClick={() => setMenu(true)}
          aria-label="Sponsored message options"
          className="-mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </div>
      <div className="text-[15px] font-semibold leading-snug text-zinc-50 [overflow-wrap:anywhere]">{ad.title}</div>
      {ad.body && <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-zinc-300 [overflow-wrap:anywhere]">{ad.body}</p>}
      {ad.image && (
        <div className="mt-3 overflow-hidden rounded-2xl bg-zinc-900" style={{ aspectRatio: `${ad.image.w} / ${ad.image.h}`, maxHeight: 320 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ad.image.src} alt="" width={ad.image.w} height={ad.image.h} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
      )}
      <button
        type="button"
        onClick={open}
        className="mt-3 flex h-11 w-full items-center justify-center rounded-2xl bg-emerald-500/15 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/25 active:scale-[0.99]"
      >
        {ad.ctaLabel || "Learn more"}
      </button>

      <Layer>
        <Sheet open={menu} onClose={() => setMenu(false)} title="Sponsored">
          <div className="space-y-1">
            <MenuItem
              icon={<Info className="h-4 w-4" />}
              label="Why am I seeing this?"
              onClick={() => {
                setMenu(false);
                setWhy(true);
              }}
            />
            <MenuItem
              icon={<Ban className="h-4 w-4" />}
              label="Hide this message"
              disabled={busy}
              onClick={() => {
                setMenu(false);
                void feedback("hide");
              }}
            />
            <MenuItem
              icon={<Flag className="h-4 w-4" />}
              label="Report"
              danger
              onClick={() => {
                setMenu(false);
                setReport(true);
              }}
            />
          </div>
        </Sheet>

        <Sheet open={why} onClose={() => setWhy(false)} title="Why am I seeing this?">
          <div className="space-y-3 text-sm leading-relaxed text-zinc-300">
            <p>
              Sponsored messages help keep Open Lounge free. Everyone who opens this screen can see the same message — it isn&apos;t picked using your profile,
              your messages, your contacts or your activity.
            </p>
            <p>
              We don&apos;t track whether you view or tap it, and there are no third-party ad trackers in the app. Sponsored messages never appear in your
              one-to-one chats.
            </p>
            <p className="text-zinc-500">You can hide any sponsored message, or report it if something looks wrong.</p>
          </div>
        </Sheet>

        <Sheet open={report} onClose={() => setReport(false)} title="Report sponsored message">
          <div className="space-y-1">
            {REASONS.map((r) => (
              <MenuItem
                key={r.id}
                label={r.label}
                disabled={busy}
                onClick={() => {
                  setReport(false);
                  void feedback("report", r.id);
                }}
              />
            ))}
          </div>
        </Sheet>
      </Layer>
    </div>
  );
}

/** Sheets render at the document root: page wrappers can form stacking contexts (transforms) that would trap them. */
function Layer({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.body), []);
  return el ? createPortal(children, el) : null;
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-[15px] hover:bg-white/5 disabled:opacity-50",
        danger ? "text-red-400" : "text-zinc-100",
      )}
    >
      {icon && <span className="text-zinc-400">{icon}</span>}
      {label}
    </button>
  );
}

/** Fetches the (single) sponsored message for this view; renders nothing when the slot is off or empty. */
export function SponsoredSlot({ placement, chat, className }: { placement: "rooms" | "groups"; chat?: string; className?: string }) {
  const { me } = useApp();
  const key = `${placement}:${chat ?? ""}`;
  const [ad, setAd] = useState<SponsoredAd | null>(() => slotCache.get(key)?.ad ?? null);
  useEffect(() => {
    if (!me?.id) return;
    if (placement === "groups" && !chat?.startsWith("g_")) return; // never in 1:1 DMs
    const hit = slotCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) {
      setAd(hit.ad && !hiddenNow.has(hit.ad.id) ? hit.ad : null);
      return;
    }
    let live = true;
    const sp = new URLSearchParams({ placement });
    if (chat) sp.set("chat", chat);
    authFetch(`/sp/slot?${sp}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean; ad?: SponsoredAd | null } | null) => {
        const next = j?.ok && j.ad && !hiddenNow.has(j.ad.id) ? j.ad : null;
        slotCache.set(key, { at: Date.now(), ad: next });
        if (live) setAd(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [me?.id, placement, chat, key]);
  if (!ad) return null;
  return <SponsoredCard ad={ad} className={className} onHidden={() => setAd(null)} />;
}
