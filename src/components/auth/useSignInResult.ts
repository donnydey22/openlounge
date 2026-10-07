"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "../AppProvider";
import { savePendingSignup, type PendingSignup, type SignInResult } from "@/lib/authApi";

/** What to do with a session / signup ticket / "linked" answer from /auth/exchange or /auth/email/verify. */
export function useSignInResult() {
  const { completeLogin, toast } = useApp();
  const router = useRouter();
  return useCallback(
    (res: SignInResult, method: PendingSignup["method"]) => {
      if (res.status === "existing") {
        completeLogin(res.token, res, { resumeSocket: true });
        toast(`👋 Welcome back, ${res.user.name.split(" ")[0]}!`);
        router.replace("/");
      } else if (res.status === "new") {
        // continue in the normal onboarding screens (name → username → photo → bio)
        savePendingSignup({ ticket: res.ticket, firstName: res.profile?.firstName, lastName: res.profile?.lastName, email: res.profile?.email, method });
        router.replace("/");
      } else if (res.status === "linked") {
        router.replace(`/settings?linked=${encodeURIComponent(res.provider)}`);
      }
    },
    [completeLogin, toast, router],
  );
}
