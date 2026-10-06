"use client";

import { useApp } from "./AppProvider";
import { AuthFlow } from "./auth/AuthFlow";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, onboarding } = useApp();
  // AuthFlow stays mounted from "signedOut" straight into post-signup onboarding steps
  if (status === "signedOut" || (status === "ready" && onboarding)) return <AuthFlow />;
  if (status !== "ready") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-zinc-500">
        <div className="animate-pulse text-4xl">🎙️</div>
        <p className="text-sm">{status === "connecting" ? "Signing you in…" : "Loading…"}</p>
      </div>
    );
  }
  return <>{children}</>;
}
