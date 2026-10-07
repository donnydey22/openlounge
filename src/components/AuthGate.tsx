"use client";

import { useApp } from "./AppProvider";
import { AuthFlow } from "./auth/AuthFlow";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, onboarding } = useApp();
  // AuthFlow stays mounted from "signedOut" straight into post-signup onboarding steps
  if (status === "signedOut" || (status === "ready" && onboarding)) return <AuthFlow />;
  if (status !== "ready") {
    return (
      // neutral splash while the stored session is checked (no text: nothing to read, nothing alarming)
      <div className="flex min-h-dvh flex-col items-center justify-center" data-testid="splash" aria-busy="true" aria-label="Open Lounge">
        <div className="animate-pulse text-4xl">🎙️</div>
      </div>
    );
  }
  return <>{children}</>;
}
