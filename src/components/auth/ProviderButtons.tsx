"use client";

// "Continue with Apple / Google / email" — rendered below the phone option, each only when the server has that
// provider configured (GET /auth/providers). Apple button follows Apple's HIG (system font, Apple logo left of the
// title, white-on-dark / black-on-light, same height as the other buttons); Google follows Google's branding
// guidelines (standard "G" mark, neutral light/dark theme).

import { useEffect, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { canUseOAuth, fetchProviders, startOAuth, type OAuthProvider, type ProviderFlags } from "@/lib/authApi";
import { cn } from "@/lib/utils";

export function AppleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 17 20" className={className} aria-hidden fill="currentColor">
      <path d="M14.04 10.63c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.77-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.28-1.6 2.78-.41 6.9 1.15 9.16.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.76-2.23.87-1.28 1.23-2.51 1.25-2.58-.03-.01-2.4-.92-2.42-3.65zM11.77 3.88c.63-.77 1.06-1.83.94-2.88-.91.04-2.01.6-2.66 1.37-.58.67-1.09 1.75-.96 2.78 1.02.08 2.05-.52 2.68-1.27z" />
    </svg>
  );
}

export function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

const base =
  "flex w-full items-center justify-center gap-2.5 rounded-full py-3.5 text-[17px] font-semibold transition duration-200 active:scale-[0.98] disabled:opacity-50";

export function useProviders() {
  const [flags, setFlags] = useState<ProviderFlags | null>(null);
  useEffect(() => {
    let live = true;
    void fetchProviders().then((f) => live && setFlags(f));
    return () => {
      live = false;
    };
  }, []);
  return flags;
}

export function ProviderButtons({ onEmail, className, divider = true }: { onEmail: () => void; className?: string; divider?: boolean }) {
  const flags = useProviders();
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  if (!flags) return null;
  const oauth = canUseOAuth();
  const apple = flags.apple && oauth;
  const google = flags.google && oauth;
  if (!apple && !google && !flags.email) return null; // nothing configured: the screen looks exactly as before

  const start = async (p: OAuthProvider) => {
    setBusy(p);
    try {
      await startOAuth(p);
    } finally {
      // a full-page redirect normally unloads us; in a native shell the system browser takes over
      setTimeout(() => setBusy(null), 4000);
    }
  };

  return (
    <div className={cn("w-full", className)} data-testid="provider-buttons">
      {divider && (
        <div className="my-5 flex items-center gap-3 text-xs font-medium tracking-wide text-zinc-500 uppercase">
          <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
        </div>
      )}
      <div className="space-y-3">
        {apple && (
          <button type="button" onClick={() => start("apple")} disabled={!!busy} className={cn(base, "btn-apple font-[system-ui]")} style={{ fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}>
            {busy === "apple" ? <Loader2 className="h-5 w-5 animate-spin" /> : <AppleLogo className="-mt-0.5 h-[19px] w-[16px]" />}
            Continue with Apple
          </button>
        )}
        {google && (
          <button type="button" onClick={() => start("google")} disabled={!!busy} className={cn(base, "btn-google")}>
            {busy === "google" ? <Loader2 className="h-5 w-5 animate-spin" /> : <GoogleLogo className="h-[18px] w-[18px]" />}
            Continue with Google
          </button>
        )}
        {flags.email && (
          <button type="button" onClick={onEmail} disabled={!!busy} className={cn(base, "border border-white/15 bg-zinc-900 text-zinc-100 hover:bg-zinc-800")}>
            <Mail className="h-[18px] w-[18px]" />
            Continue with email
          </button>
        )}
      </div>
    </div>
  );
}
