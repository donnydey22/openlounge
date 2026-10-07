"use client";

import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { biometricsBridge, readBiometrics, setBiometrics, type BiometricsBridge } from "@/lib/biometrics";
import { cn } from "@/lib/utils";

/** Settings row: opt-in App lock (Face ID / fingerprint). Only rendered inside the native apps that offer it. */
export function AppLockToggle() {
  const [bridge, setBridge] = useState<BiometricsBridge | null>(null);
  const [state, setState] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const b = biometricsBridge();
    setBridge(b);
    if (b) void readBiometrics(b).then(setState);
  }, []);

  if (!bridge || !state) return null;
  const { available, enabled } = state;

  const toggle = async () => {
    if (busy || !available) return;
    setBusy(true);
    // turning it on shows the system prompt first; the native side resolves with the resulting state
    const now = await setBiometrics(bridge, !enabled);
    setState({ available, enabled: now });
    setBusy(false);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70" data-testid="applock-setting">
      <button onClick={toggle} disabled={busy || !available} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm">
        <span className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4" /> App lock (Face ID / fingerprint)
        </span>
        <span
          role="switch"
          aria-checked={enabled}
          aria-label="App lock"
          className={cn("relative h-6 w-11 rounded-full transition", enabled ? "bg-emerald-500" : "bg-zinc-700", !available && "opacity-50")}
        >
          <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all", enabled ? "left-[22px]" : "left-0.5")} />
        </span>
      </button>
      <p className="-mt-1 px-4 pb-3 text-xs leading-relaxed text-zinc-500" data-testid="applock-setting-hint">
        {!available
          ? "Set up a screen lock (passcode, PIN or pattern) on this device to use App lock."
          : enabled
            ? "Open Lounge asks for Face ID, fingerprint or your device passcode when you open it or come back after a minute. You stay signed in."
            : "Unlock Open Lounge with Face ID or fingerprint instead of signing in again."}
      </p>
    </div>
  );
}
