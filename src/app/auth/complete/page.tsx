"use client";

// Where Google / Apple sign-in lands: /auth/complete?code=<one-time code> (or ?error=…). The page redeems the code
// with POST /auth/exchange and continues like any other sign-in. Native shells route openlounge://auth?code=… here too.

import { Logo } from "@/components/brand/LogoMark";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Footer, PrimaryButton, Shell, Title } from "@/components/auth/ui";
import { AuthFormError, OAUTH_ERRORS, authPost, takeVerifier, type SignInResult } from "@/lib/authApi";
import { deviceHint } from "@/lib/auth";
import { useSignInResult } from "@/components/auth/useSignInResult";
import { useApp } from "@/components/AppProvider";

export default function AuthCompletePage() {
  const router = useRouter();
  const handle = useSignInResult();
  const { status } = useApp();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    const err = q.get("error");
    history.replaceState(null, "", "/auth/complete");
    if (!code) return setError(OAUTH_ERRORS[err ?? ""] ?? OAUTH_ERRORS.failed);
    authPost<SignInResult & { provider?: string }>("/auth/exchange", { code, codeVerifier: takeVerifier(), device: deviceHint() })
      .then((res) => handle(res, (res.provider === "apple" ? "apple" : "google") as "google" | "apple"))
      .catch((e) => setError(e instanceof AuthFormError ? e.message : OAUTH_ERRORS.failed));
  }, [handle]);

  if (!error)
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
      </div>
    );
  const signedIn = status === "ready";
  return (
    <Shell stepKey="error">
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <Logo size={80} wordmark={false} className="mb-6" />
        <Title sub={error}>{signedIn ? "Couldn't connect that account" : "Let's try that again"}</Title>
      </div>
      <Footer>
        <PrimaryButton onClick={() => router.replace(signedIn ? "/settings" : "/")}>{signedIn ? "Back to settings" : "Back to sign in"}</PrimaryButton>
      </Footer>
    </Shell>
  );
}
