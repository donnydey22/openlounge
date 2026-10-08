"use client";

// Call service message in a DM (Telegram style): "Outgoing call · 3:12", "Missed call", "Declined call"…
// with the time and a call-back button.
import { ArrowDownLeft, ArrowUpRight, Phone, Video } from "lucide-react";
import type { CallMeta } from "@/lib/types";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { fmt } from "@/lib/calls/engine";

export function callLabel(meta: CallMeta, mine: boolean): { title: string; detail: string | null; missed: boolean; outgoing: boolean } {
  const d = meta.durationSec ? fmt(meta.durationSec) : null;
  if (mine) {
    switch (meta.outcome) {
      case "completed":
        return { title: "Outgoing call", detail: d, missed: false, outgoing: true };
      case "missed":
        return { title: "Outgoing call", detail: "No answer", missed: false, outgoing: true };
      case "declined":
        return { title: "Outgoing call", detail: "Declined", missed: false, outgoing: true };
      case "busy":
        return { title: "Outgoing call", detail: "Busy", missed: false, outgoing: true };
      case "cancelled":
        return { title: "Cancelled call", detail: null, missed: false, outgoing: true };
      default:
        return { title: "Call failed", detail: null, missed: true, outgoing: true };
    }
  }
  if (meta.outcome === "completed") return { title: "Incoming call", detail: d, missed: false, outgoing: false };
  if (meta.outcome === "declined") return { title: "Declined call", detail: null, missed: false, outgoing: false };
  return { title: "Missed call", detail: null, missed: true, outgoing: false };
}

export function CallMessageRow({
  meta,
  mine,
  time,
  sep,
  sepTitle,
  first,
  last,
  peer,
  onCallBack,
  disabled,
}: {
  meta: CallMeta;
  mine: boolean;
  time: string;
  sep: string | null;
  sepTitle?: string;
  first: boolean;
  last: boolean;
  peer: { name: string; color: string; photoUrl?: string | null } | null;
  onCallBack: (video: boolean) => void;
  disabled?: boolean;
}) {
  const l = callLabel(meta, mine);
  const Arrow = l.outgoing ? ArrowUpRight : ArrowDownLeft;
  return (
    <div data-testid="dm-msg" data-mine={mine ? "1" : "0"} data-kind="call">
      {sep && (
        <div className="mt-4 mb-2 text-center text-[11px] font-medium text-zinc-500" title={sepTitle}>
          {sep}
        </div>
      )}
      <div className={cn("flex items-end gap-2", mine ? "justify-end pl-12" : "justify-start pr-12", first ? "mt-2" : "mt-[3px]")}>
        {!mine && <div className="w-7 shrink-0">{last && peer && <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="xs" />}</div>}
        <div
          data-testid="call-msg"
          data-outcome={meta.outcome}
          className={cn("flex min-w-[200px] max-w-[280px] items-center gap-3 rounded-[18px] py-2 pr-2 pl-3.5", mine ? "bg-emerald-500 text-on-accent" : "dm-theirs bg-zinc-800 text-zinc-100")}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{l.title}</div>
            <div className={cn("flex items-center gap-1 text-[12px]", mine ? "opacity-85" : "text-zinc-400")}>
              <Arrow className={cn("h-3.5 w-3.5", l.missed ? "text-red-400" : mine ? "" : "text-emerald-400")} strokeWidth={2.5} />
              <span>{time}</span>
              {l.detail && <span>· {l.detail}</span>}
              {meta.video && <span>· video</span>}
            </div>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onCallBack(meta.video)}
            aria-label={meta.video ? "Video call back" : "Call back"}
            data-testid="call-back"
            className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full transition active:scale-90 disabled:opacity-40", mine ? "bg-white/20 hover:bg-white/30" : "bg-white/10 hover:bg-white/15")}
          >
            {meta.video ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
