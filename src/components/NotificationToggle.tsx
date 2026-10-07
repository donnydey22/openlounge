"use client";

import { useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useNotificationState } from "./Notifier";
import { registerServiceWorker, requestPermission, unblockHint, writePref } from "@/lib/notify";
import { cn } from "@/lib/utils";

/** Settings row: turn notifications on/off (asks the browser the first time), or explain how to unblock. */
export function NotificationToggle() {
  const { support, permission, enabled } = useNotificationState();
  const [busy, setBusy] = useState(false);
  if (support === "unsupported") return null; // e.g. the Android app's WebView: nothing to offer

  if (support === "ios-install") {
    return (
      <div className="mt-3 rounded-2xl border border-white/5 bg-zinc-900/70 px-4 py-3 text-sm" data-testid="notif-setting">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4" /> Notifications
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          To get notifications on iPhone, add Open Lounge to your Home Screen (Share → Add to Home Screen) and open it from there.
        </p>
      </div>
    );
  }

  const denied = permission === "denied";
  const on = enabled && !denied;
  const toggle = async () => {
    if (denied || busy) return;
    if (permission === "granted") {
      writePref(on ? "disabled" : "enabled");
      if (!on) void registerServiceWorker();
      return;
    }
    // not asked yet: this tap is the user gesture the browser requires
    setBusy(true);
    await requestPermission();
    setBusy(false);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70" data-testid="notif-setting">
      <button onClick={toggle} disabled={busy} aria-disabled={denied} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm">
        <span className="flex items-center gap-2">
          {on ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />} Notifications
        </span>
        <span
          role="switch"
          aria-checked={on}
          aria-label="Notifications"
          className={cn("relative h-6 w-11 rounded-full transition", on ? "bg-emerald-500" : "bg-zinc-700", denied && "opacity-50")}
        >
          <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
        </span>
      </button>
      <p className="-mt-1 px-4 pb-3 text-xs leading-relaxed text-zinc-500" data-testid="notif-setting-hint">
        {denied ? (
          <>
            <span className="text-amber-400">Blocked in your browser.</span> {unblockHint()}
          </>
        ) : on ? (
          "You'll get a heads-up when people join your room, message you, or start talking while Open Lounge is in the background."
        ) : (
          "Get a heads-up when people join your room, message you, or start talking while you're away."
        )}
      </p>
    </div>
  );
}
