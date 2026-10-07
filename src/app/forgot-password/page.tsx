"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { ErrorText, Footer, PrimaryButton, Shell, TextInput, Title } from "@/components/auth/ui";
import { AuthFormError, authPost } from "@/lib/authApi";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await authPost("/auth/password/forgot", { email: email.trim() });
      setSent(true);
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Shell stepKey="sent" onBack={() => router.push("/?signin=email")}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 text-6xl">📬</div>
          <h1 className="text-[26px] leading-tight font-bold tracking-tight">Check your email</h1>
          <p className="mt-3 max-w-xs text-[15px] leading-relaxed text-zinc-400">
            If an Open Lounge account uses <span className="font-semibold text-zinc-200">{email.trim()}</span>, we&apos;ve sent it a link to reset your password. The link works for 30 minutes.
          </p>
        </div>
        <Footer>
          <PrimaryButton onClick={() => router.push("/?signin=email")}>Back to sign in</PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  return (
    <Shell stepKey="form" onBack={() => router.push("/?signin=email")}>
      <Title sub="Enter the email you use for Open Lounge and we'll send you a link to choose a new password.">Forgot your password?</Title>
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) submit();
        }}
      >
        <div className="mt-8">
          <TextInput autoFocus type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} aria-label="Email" placeholder="you@example.com" value={email} onChange={setEmail} maxLength={254} />
        </div>
        <ErrorText>{error}</ErrorText>
        <Footer>
          <PrimaryButton type="submit" disabled={!ok} busy={busy}>
            Send reset link <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </Footer>
      </form>
    </Shell>
  );
}
