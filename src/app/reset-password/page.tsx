"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { ErrorText, Footer, PasswordInput, PrimaryButton, Shell, Title } from "@/components/auth/ui";
import { AuthFormError, authPost } from "@/lib/authApi";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(location.search).get("token");
    setToken(t ?? "");
    // keep the secret out of history / referrers once read
    if (t) history.replaceState(null, "", "/reset-password");
  }, []);

  const mismatch = confirm.length > 0 && confirm !== password;
  const ok = password.length >= 8 && confirm === password;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await authPost<{ email?: string }>("/auth/password/reset", { token, password });
      setDone(r.email ?? "");
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <Shell stepKey="done">
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 text-6xl">🔐</div>
          <h1 className="text-[26px] leading-tight font-bold tracking-tight">Password updated</h1>
          <p className="mt-3 max-w-xs text-[15px] leading-relaxed text-zinc-400">You&apos;ve been signed out on every device. Sign in with your new password.</p>
        </div>
        <Footer>
          <PrimaryButton onClick={() => router.push("/?signin=email")}>Sign in</PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  if (token === "") {
    return (
      <Shell stepKey="missing">
        <Title sub="Open the link from your email again, or request a new one.">This reset link isn&apos;t complete</Title>
        <Footer>
          <PrimaryButton onClick={() => router.push("/forgot-password")}>Request a new link</PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  return (
    <Shell stepKey="form">
      <Title sub="Choose a new password for your Open Lounge account.">Reset your password</Title>
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && token) submit();
        }}
      >
        <div className="mt-8 space-y-3">
          <PasswordInput autoFocus autoComplete="new-password" aria-label="New password" placeholder="New password" value={password} onChange={setPassword} />
          <PasswordInput autoComplete="new-password" aria-label="Confirm new password" placeholder="Confirm new password" value={confirm} onChange={setConfirm} />
          <p className={cn("px-1 text-xs", mismatch || (password && password.length < 8) ? "text-amber-400" : "text-zinc-500")}>
            {mismatch ? "Passwords don't match yet." : "At least 8 characters. Changing it signs you out everywhere."}
          </p>
        </div>
        <ErrorText>{error}</ErrorText>
        {error && /expired|already used/i.test(error) && (
          <div className="mt-3 text-center">
            <a href="/forgot-password" className="text-sm font-semibold text-sky-400 hover:underline">
              Request a new link →
            </a>
          </div>
        )}
        <Footer>
          <PrimaryButton type="submit" disabled={!ok || !token} busy={busy}>
            Save new password <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </Footer>
      </form>
    </Shell>
  );
}
