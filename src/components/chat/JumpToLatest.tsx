"use client";
// Round floating "jump to latest" button (WhatsApp/Telegram style): down arrow + unread badge, 44px tap target.
import { ChevronDown } from "lucide-react";
import { badgeText } from "@/lib/chatScroll";

export function JumpToLatest({ show, unseen, onJump, testId = "jump-latest" }: { show: boolean; unseen: number; onJump: () => void; testId?: string }) {
  const badge = badgeText(unseen);
  return (
    <button
      type="button"
      onClick={onJump}
      data-testid={testId}
      data-show={show ? "1" : "0"}
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      aria-label={unseen > 0 ? `Jump to latest message, ${unseen} new` : "Jump to latest message"}
      className={
        "jump-latest absolute right-3 bottom-3 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-900/95 text-zinc-100 shadow-lg ring-1 ring-white/10 backdrop-blur transition-[opacity,transform] duration-200 ease-out hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-emerald-400 active:scale-95 rtl:right-auto rtl:left-3 " +
        (show ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-2 scale-90 opacity-0")
      }
    >
      <ChevronDown className="h-6 w-6" strokeWidth={2.25} aria-hidden />
      {badge && (
        <span
          data-testid={`${testId}-badge`}
          className="absolute -top-1.5 left-1/2 min-w-5 -translate-x-1/2 rounded-full bg-emerald-500 px-1.5 text-center text-[11px] leading-5 font-bold text-black tabular-nums shadow"
        >
          {badge}
        </span>
      )}
    </button>
  );
}
