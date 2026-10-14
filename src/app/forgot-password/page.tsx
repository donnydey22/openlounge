"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { ErrorText, Footer, PrimaryButton, Shell, TextInput, Title } from "@/components/auth/ui";
import { AuthFormError, authPost } from "@/lib/authApi";

export default function ForgotPasswordPage() {
  const router = useRouter();
  // one field: email OR screen name (prefilled from the sign-in screen via ?id=)
  const [email, setEmail] = useState("");
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("id");
    if (id) setEmail(id.slice(0, 254));
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const v = email.trim();
  const isEmail = v.includes("@") && !v.startsWith("@");
  const ok = isEmail ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) : /^[a-z0-9_]{3,20}$/i.test(v.replace(/^@/, ""));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await authPost("/auth/password/forgot", { identifier: v });
      setSent(true);
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Shell stepKey="sent" onBack={() => router.push("/?signin=1")}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 text-6xl">📬</div>
          <h1 className="text-[26px] leading-tight font-bold tracking-tight">Check your email</h1>
          <p className="mt-3 max-w-xs text-[15px] leading-relaxed text-zinc-400">
            If an Open Lounge account matches <span className="font-semibold text-zinc-200">{isEmail ? v : `@${v.replace(/^@/, "")}`}</span>, we&apos;ve sent a link to its email to reset your password. The link works for 30 minutes.
          </p>
        </div>
        <Footer>
          <PrimaryButton onClick={() => router.push("/?signin=1")}>Back to sign in</PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  return (
    <Shell stepKey="form" onBack={() => router.push("/?signin=1")}>
      <Title sub="Enter your email or screen name and we'll email you a link to choose a new password.">Forgot your password?</Title>
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) submit();
        }}
      >
        <div className="mt-8">
          <TextInput autoFocus type="text" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="send" aria-label="Email or screen name" placeholder="Email or screen name" value={email} onChange={setEmail} maxLength={254} />
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
