"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Footer, PrimaryButton, Shell, Title } from "@/components/auth/ui";
import { AuthFormError, authPost, type SignInResult } from "@/lib/authApi";
import { deviceHint } from "@/lib/auth";
import { useSignInResult } from "@/components/auth/useSignInResult";

export default function VerifyEmailPage() {
  const router = useRouter();
  const handle = useSignInResult();
  const [state, setState] = useState<{ kind: "working" } | { kind: "error"; message: string } | { kind: "exists"; email?: string }>({ kind: "working" });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = new URLSearchParams(location.search).get("token");
    history.replaceState(null, "", "/verify-email");
    if (!token) return setState({ kind: "error", message: "This link isn't complete. Open it from your email again." });
    authPost<SignInResult>("/auth/email/verify", { token, device: deviceHint() })
      .then((res) => (res.status === "exists" ? setState({ kind: "exists", email: res.email }) : handle(res, "email")))
      .catch((e) => setState({ kind: "error", message: e instanceof AuthFormError ? e.message : "Something went wrong. Please try again." }));
  }, [handle]);

  if (state.kind === "working")
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
      </div>
    );
  return (
    <Shell stepKey={state.kind}>
      {state.kind === "exists" ? (
        <Title sub="This email is already confirmed on an Open Lounge account. Sign in with your password.">You already have an account</Title>
      ) : (
        <Title sub={state.message}>Let&apos;s try that again</Title>
      )}
      <Footer>
        <PrimaryButton onClick={() => router.replace("/?signin=email")}>Go to sign in</PrimaryButton>
      </Footer>
    </Shell>
  );
}
