"use client";

import { Logo } from "@/components/brand/LogoMark";
import { usePathname } from "next/navigation";
import { useApp } from "./AppProvider";
import { AuthFlow } from "./auth/AuthFlow";

/** Pages reachable without a session (email links, OAuth return) — they render on their own, no splash / sign-in gate. */
export const PUBLIC_AUTH_PAGES = ["/forgot-password", "/reset-password", "/verify-email", "/auth/complete"];

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, onboarding } = useApp();
  const pathname = usePathname() ?? "";
  if (PUBLIC_AUTH_PAGES.includes(pathname.replace(/\/+$/, ""))) return <>{children}</>;
  // public pages: shared profile links (/@handle → /u/handle) and privacy notes
  if (/^\/(u\/|@|%40|privacy)/.test(pathname)) return <>{children}</>;
  // AuthFlow stays mounted from "signedOut" straight into post-signup onboarding steps
  if (status === "signedOut" || (status === "ready" && onboarding)) return <AuthFlow />;
  if (status !== "ready") {
    return (
      // neutral splash while the stored session is checked (no text: nothing to read, nothing alarming)
      <div className="flex min-h-dvh flex-col items-center justify-center" data-testid="splash" aria-busy="true" aria-label="Open Lounge">
        <Logo size={72} playOnMount wordmark={false} />
      </div>
    );
  }
  return <>{children}</>;
}
