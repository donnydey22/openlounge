"use client";

// Clubhouse-style onboarding:
//   welcome → phone → code → (returning: hallway)
//                           → name → username → photo → bio → [account created] → interests → follow → hallway
// Phone verification goes through the server's OtpService (demo SMS provider by default).

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Camera, Check, Fingerprint, Loader2, Mail, Phone } from "lucide-react";
import { AVATAR_COLORS, USERNAME_RE, type PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fileToAvatarDataUrl } from "@/lib/image";
import { Avatar } from "../Avatar";
import { InterestChips } from "../profile/InterestChips";
import { useApp, type SessionPayload } from "../AppProvider";
import { COUNTRIES, formatNational } from "./countries";
import { ErrorText, Footer, PasswordInput, PrimaryButton, Shell, TextInput, Title } from "./ui";
import { IconSlot, ProviderButtons } from "./ProviderButtons";
import { biometricAuthenticate, biometricsBridge, quickSignInReady } from "@/lib/biometrics";
import { forgetParked, readParked, unparkSession, type ParkedSession } from "@/lib/session";
import { AuthFormError, authPost, linkPendingToPhone, markSuggestLink, takePendingSignup, type PendingSignup, type SessionResult, type SignInResult } from "@/lib/authApi";
import type { PhoneSession } from "@/lib/firebaseClient";

/** A signup handed over by /auth/complete (Google/Apple) or /verify-email, or ?signin=email from an email link. */
function initialEntry(): { step: Step; pending: PendingSignup | null } {
  if (typeof window === "undefined") return { step: "welcome", pending: null };
  const pending = takePendingSignup();
  if (pending) return { step: pending.linkCode ? "linkChoice" : "name", pending };
  return { step: new URLSearchParams(location.search).get("signin") ? "signin" : "welcome", pending: null };
}

type Step = "linkChoice" | "welcome" | "signin" | "phone" | "code" | "emailCode" | "emailOtp" | "email" | "emailSignup" | "emailSent" | "name" | "username" | "photo" | "bio" | "interests" | "follow";

// Welcome wordmark: big staggered letter entrance, then a strong steady pulse (globals.css .ol-splash-*).
function SplashWordmark() {
  return (
    <span className="ol-word ol-splash-word font-bold tracking-tight whitespace-nowrap text-3xl" aria-label="Open Lounge">
      {Array.from("Open Lounge").map((ch, i) => (
        <span key={i} aria-hidden="true" style={{ animationDelay: `${120 + i * 45}ms, ${1400 + i * 45}ms` }}>
          {ch === " " ? "\u00a0" : ch}
        </span>
      ))}
    </span>
  );
}

export function AuthFlow() {
  const { request, completeLogin, finishOnboarding, onboarding, follow, updateMe, connected, toast } = useApp();
  const [entry] = useState(initialEntry);
  const [step, setStep] = useState<Step>(onboarding ? "interests" : entry.step);
  /** how this person proved who they are (phone OTP, or a ticket from email / Google / Apple) */
  const [method, setMethod] = useState<"phone" | PendingSignup["method"]>(entry.pending?.method ?? "phone");
  // email + password
  const [email, setEmail] = useState(entry.pending?.email ?? "");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // unified sign-in: one field = email OR screen name
  const [identifier, setIdentifier] = useState(entry.pending?.email ?? "");
  // App lock quick sign-in: a parked session for this screen name in the native encrypted store
  const [parked, setParked] = useState<ParkedSession | null>(null);
  useEffect(() => {
    let off = false;
    void (async () => {
      if (!(await quickSignInReady(biometricsBridge()))) return;
      const p = await readParked();
      if (!off && p) setParked(p);
    })();
    return () => {
      off = true;
    };
  }, []);
  // SMS trouble (error / timeout / no text) → offer "Email me a code instead"
  const [smsTrouble, setSmsTrouble] = useState(false);

  // phone + code
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [national, setNational] = useState("");
  const [phoneE164, setPhoneE164] = useState("");
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [ticket, setTicket] = useState(entry.pending?.ticket ?? "");
  // "Already have an account?": the pending Google/Apple/email identity waiting for phone proof
  const [linkCode, setLinkCode] = useState(entry.pending?.linkCode ?? "");
  const [linking, setLinking] = useState(false);
  const providerName = method === "apple" ? "Apple" : method === "email" ? "your email" : "Google";
  // Firebase Phone Auth when the server has it on; demo OTP (auth:requestCode) otherwise
  const [authCfg, setAuthCfg] = useState<{ firebase: boolean; demoOtp: boolean } | null>(null);
  const confirmation = useRef<PhoneSession | null>(null);
  useEffect(() => {
    if (!connected || authCfg) return;
    request<{ firebase: boolean; demoOtp: boolean }>("auth:config")
      .then((c) => setAuthCfg({ firebase: !!c.firebase, demoOtp: c.demoOtp !== false }))
      .catch(() => setAuthCfg({ firebase: false, demoOtp: true }));
  }, [connected, authCfg, request]);

  // profile
  const [firstName, setFirstName] = useState(entry.pending?.firstName ?? "");
  const [lastName, setLastName] = useState(entry.pending?.lastName ?? "");
  const [username, setUsername] = useState("");
  const [usernameState, setUsernameState] = useState<{ checking: boolean; available: boolean | null; reason: string | null }>({
    checking: false,
    available: null,
    reason: null,
  });
  const [color, setColor] = useState<string>(() => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [bio, setBio] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<PublicUser[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const go = (s: Step) => {
    setError(null);
    setStep(s);
  };

  // resend countdown
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const digits = national.replace(/\D/g, "");
  const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");

  async function sendCode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSmsTrouble(false);
    try {
      if (authCfg?.firebase) {
        const e164 = `+${(country.dial + digits).replace(/\D/g, "")}`;
        const { sendPhoneCode } = await import("@/lib/firebaseClient");
        // reCAPTCHA / SMS can hang (blocked script, flaky network): never spin forever
        confirmation.current = await withTimeout(sendPhoneCode(e164, "recaptcha-container"), SMS_SEND_TIMEOUT_MS, "We couldn't send the text. Try again, or get a code by email instead.");
        setPhoneE164(e164);
        setDemoCode(null);
        setResendIn(30);
        setCode("");
        go("code");
        // Android native instant verification: no code to type — continue straight away.
        if (confirmation.current.instantToken) setTimeout(() => void verify("000000"), 0);
        return;
      }
      const res = await request<{ phone: string; demoCode?: string; resendIn: number }>("auth:requestCode", { phone: country.dial + digits });
      setPhoneE164(res.phone);
      setDemoCode(res.demoCode ?? null);
      setResendIn(res.resendIn);
      setCode("");
      go("code");
    } catch (e) {
      setError((e as Error).message);
      setSmsTrouble(true);
    } finally {
      setBusy(false);
    }
  }

  // on the code screen: no text after a while → show the email option too
  useEffect(() => {
    if (step !== "code") return;
    const t = setTimeout(() => setSmsTrouble(true), SMS_WAIT_MS);
    return () => clearTimeout(t);
  }, [step, phoneE164]);

  async function signIn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authPost<SessionResult>("/auth/email/login", { identifier: identifier.trim(), password });
      completeLogin(res.token, res, { resumeSocket: true });
      toast(`👋 Welcome back, ${res.user.name.split(" ")[0]}!`);
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function quickSignIn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await biometricAuthenticate(biometricsBridge()))) {
        setError("Face ID / fingerprint didn't go through. Try again, or use your password.");
        return;
      }
      if (!(await unparkSession())) {
        setParked(null);
        setError("That saved sign-in has expired. Use your password, a text code or an email code.");
        return;
      }
      location.replace("/"); // boots with the restored session (server re-validates and rotates it)
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      type VerifyRes = ({ status: "existing"; token: string } & SessionPayload) | { status: "new"; ticket: string };
      let res: VerifyRes;
      if (linking) {
        // link mode: only a real Firebase phone verification can prove the number (never demo codes)
        if (!authCfg?.firebase || !confirmation.current) throw new Error("Phone verification isn't available right now. Go back and create a new account, or try again later.");
        const { confirmPhoneCode } = await import("@/lib/firebaseClient");
        const idToken = await confirmPhoneCode(confirmation.current, value);
        const r = await linkPendingToPhone(linkCode, idToken);
        if (!r.ok) {
          if (r.linkCode) setLinkCode(r.linkCode);
          else setLinking(false);
          throw new Error(r.error);
        }
        completeLogin(r.res.token, r.res, { resumeSocket: true });
        toast(`✅ ${providerName === "your email" ? "Email" : providerName} is now linked. Welcome back, ${r.res.user.name.split(" ")[0]}!`);
        return;
      }
      if (authCfg?.firebase && confirmation.current) {
        const { confirmPhoneCode } = await import("@/lib/firebaseClient");
        const idToken = await confirmPhoneCode(confirmation.current, value);
        res = await request<VerifyRes>("auth:verifyFirebase", { idToken });
      } else {
        res = await request<VerifyRes>("auth:verifyCode", { phone: phoneE164, code: value });
      }
      if (res.status === "existing") {
        markSuggestLink();
        completeLogin(res.token, res);
        toast(`👋 Welcome back, ${res.user.name.split(" ")[0]}!`);
      } else {
        setTicket(res.ticket);
        go("name");
      }
    } catch (e) {
      setError((e as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailCode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authPost<{ email: string; resendIn: number }>("/auth/email/code/start", { email: email.trim() });
      setResendIn(r.resendIn ?? 60);
      setCode("");
      go("emailOtp");
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyEmailCode(value: string) {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authPost<SignInResult>("/auth/email/code/verify", { email: email.trim(), code: value });
      if (res.status === "existing") {
        completeLogin(res.token, res, { resumeSocket: true });
        toast(`👋 Welcome back, ${res.user.name.split(" ")[0]}!`);
      } else if (res.status === "new") {
        setMethod("email");
        setTicket(res.ticket);
        setLinkCode(res.linkCode ?? "");
        go(res.linkCode ? "linkChoice" : "name");
      } else throw new AuthFormError("Something went wrong. Please try again.");
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function emailSignUp() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await authPost("/auth/email/signup", { email, password });
      setPassword("");
      setMethod("email");
      go("emailSent");
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const idTrim = identifier.trim();
  const idIsEmail = idTrim.includes("@") && !idTrim.startsWith("@");
  const idOk = idIsEmail ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(idTrim) : USERNAME_RE.test(idTrim.replace(/^@/, "").toLowerCase());
  const quickMatch = !!parked && !idIsEmail && idTrim.replace(/^@/, "").toLowerCase() === parked.username.toLowerCase();

  // live username availability
  useEffect(() => {
    if (step !== "username") return;
    const u = username.trim().replace(/^@/, "").toLowerCase();
    if (!u) return setUsernameState({ checking: false, available: null, reason: null });
    if (!USERNAME_RE.test(u)) return setUsernameState({ checking: false, available: false, reason: "3–20 characters: letters, numbers, underscores" });
    setUsernameState((s) => ({ ...s, checking: true }));
    const t = setTimeout(async () => {
      try {
        const res = await request<{ available: boolean; reason: string | null }>("auth:checkUsername", { username: u });
        setUsernameState({ checking: false, available: res.available, reason: res.reason });
      } catch {
        setUsernameState({ checking: false, available: null, reason: null });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [username, step, request]);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const res = await request<{ token: string } & SessionPayload>("auth:register", {
        ticket,
        firstName,
        lastName,
        username: username.replace(/^@/, ""),
        bio,
        color,
        photo,
        interests: [],
      });
      completeLogin(res.token, res, { onboarding: true });
      go("interests");
    } catch (e) {
      setError((e as Error).message);
      if (/username|taken/i.test((e as Error).message)) go("username");
      if (/expired|start again/i.test((e as Error).message)) go(method === "phone" ? "phone" : "welcome");
    } finally {
      setBusy(false);
    }
  }

  async function saveInterests(list: string[]) {
    setBusy(true);
    try {
      if (list.length) await updateMe({ interests: list });
      const res = await request<{ users: PublicUser[] }>("onboarding:suggestions");
      setSuggestions(res.users);
      setPicked(new Set()); // nothing pre-selected: people choose who to follow
      go("follow");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function followAndFinish() {
    setBusy(true);
    await Promise.all([...picked].map((id) => follow(id, true)));
    setBusy(false);
    finishOnboarding();
    toast("🎉 You're in! Jump into a room.");
  }

  // username suggestions from the entered name
  const usernameIdeas = useMemo(() => {
    const f = firstName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const l = lastName.toLowerCase().replace(/[^a-z0-9]/g, "");
    return [f + l, f + (l[0] ?? ""), `${f}_${l}`.replace(/_$/, ""), f + Math.floor(Math.random() * 90 + 10)].filter((x, i, a) => x.length >= 3 && a.indexOf(x) === i).slice(0, 3);
  }, [firstName, lastName]);

  // ---------------- screens ----------------

  if (step === "linkChoice") {
    return (
      <Shell stepKey={step}>
        <Title sub={`Verify your phone number to link ${providerName} to it. Your profile, follows and messages stay the same.`}>Already have an Open Lounge account?</Title>
        <ErrorText>{error}</ErrorText>
        <Footer>
          <PrimaryButton
            onClick={() => {
              setLinking(true);
              setMode("signin");
              go("phone");
            }}
          >
            <Phone className="h-4 w-4" /> Verify my phone number
          </PrimaryButton>
          <button
            type="button"
            onClick={() => {
              setLinking(false);
              go("name");
            }}
            className="auth-alt-link text-sky-400 hover:underline"
          >
            I&apos;m new — create a new account →
          </button>
        </Footer>
      </Shell>
    );
  }

  if (step === "welcome") {
    return (
      <Shell welcome stepKey={step}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <h1 className="sr-only">Welcome to Open Lounge</h1>
          <span className="mb-2 inline-flex flex-col items-center gap-5">
            <span className="ol-splash-mic text-[80px] leading-none" aria-hidden="true">🎙️</span>
            <SplashWordmark />
          </span>
          <p className="mt-4 max-w-xs text-[15px] leading-relaxed text-zinc-400">
            Drop in on live conversations with founders, artists and friends. Raise your hand to speak up.
          </p>
          <div className="mt-8 flex -space-x-3">
            {["#EC4899", "#3B82F6", "#F97316", "#22C55E", "#8B5CF6"].map((c, i) => (
              <div key={c} className="openlounge-hex h-11 w-11 ring-4 ring-app" style={{ background: c, zIndex: 5 - i }} />
            ))}
          </div>
        </div>
        <Footer>
          <button
            type="button"
            onClick={() => {
              setMode("signup");
              go("phone");
            }}
            className="btn-auth btn-auth-primary"
          >
            <IconSlot>
              <Phone className="h-[18px] w-[18px]" strokeWidth={2.25} />
            </IconSlot>
            Continue with phone
          </button>
          <ProviderButtons onEmail={() => go("emailCode")} />
          <button
            type="button"
            onClick={() => {
              setMode("signin");
              if (parked && !identifier) setIdentifier(parked.username);
              go("signin");
            }}
            className="auth-alt-link text-sky-400 hover:underline"
            data-testid="welcome-signin"
          >
            Already have an account? Sign in →
          </button>
          <p className="mt-3 text-center text-xs leading-relaxed text-zinc-500" data-testid="legal-consent">
            By continuing you agree to our <Link href="/terms" className="underline hover:text-zinc-300">Terms of Use</Link> and <Link href="/privacy" className="underline hover:text-zinc-300">Privacy Policy</Link>.
          </p>
        </Footer>
      </Shell>
    );
  }

  if (step === "phone") {
    return (
      <Shell stepKey={step} onBack={() => go(linking ? "linkChoice" : "welcome")}>
        <Title sub={linking ? `We'll text you a code, then link ${providerName} to that account.` : mode === "signin" ? "We'll text you a code to sign back in." : undefined}>
          {linking ? "What's the phone # on your account?" : mode === "signin" ? "Welcome back! What's your phone #?" : "Enter your phone #"}
        </Title>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (digits.length >= 6) sendCode();
          }}
        >
          <div className="mt-8 flex items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900 p-2 focus-within:border-emerald-500/60">
            <label className="relative flex items-center gap-1 rounded-xl bg-zinc-800 px-3 py-2.5 text-[15px] font-medium">
              <span>{country.flag}</span>
              <span>{country.dial}</span>
              <select
                aria-label="Country code"
                value={country.code}
                onChange={(e) => setCountry(COUNTRIES.find((c) => c.code === e.target.value) ?? COUNTRIES[0])}
                className="absolute inset-0 cursor-pointer opacity-0"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.name} ({c.dial})
                  </option>
                ))}
              </select>
            </label>
            <input
              autoFocus
              inputMode="tel"
              autoComplete="tel-national"
              aria-label="Phone number"
              placeholder={country.placeholder}
              value={formatNational(national, country.code)}
              onChange={(e) => setNational(e.target.value.replace(/\D/g, "").slice(0, 14))}
              className="min-w-0 flex-1 bg-transparent px-2 text-xl tracking-wide outline-none placeholder:text-zinc-600"
            />
          </div>
          <ErrorText>{error}</ErrorText>
          {smsTrouble && !linking && <EmailFallback onClick={() => go("emailCode")} />}
          <p className="mt-6 text-center text-xs leading-relaxed text-zinc-500">
            By entering your number, you agree to our <Link href="/terms" className="underline hover:text-zinc-300">Terms of Use</Link> and <Link href="/privacy" className="underline hover:text-zinc-300">Privacy Policy</Link>, including our zero-tolerance policy for objectionable content and abusive behavior. We&apos;ll text you a 6-digit code.
          </p>
          {authCfg?.firebase && (
            <p className="mt-2 text-center text-[10px] leading-snug text-zinc-600" data-testid="recaptcha-disclosure">
              This site is protected by reCAPTCHA and the Google{" "}
              <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer" className="underline">Privacy Policy</a> and{" "}
              <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer" className="underline">Terms of Service</a> apply.
            </p>
          )}
          <Footer>
            <PrimaryButton type="submit" disabled={digits.length < 6 || !connected} busy={busy}>
              Next <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
            {!linking && <ProviderButtons onEmail={() => go("emailCode")} />}
            {linking ? null : mode !== "signin" ? (
              <button type="button" onClick={() => setMode("signin")} className="auth-alt-link text-sky-400 hover:underline">
                Already have an account? Sign in →
              </button>
            ) : (
              <button type="button" onClick={() => setMode("signup")} className="auth-alt-link text-sky-400 hover:underline">
                New here? Create an account →
              </button>
            )}
          </Footer>
        </form>
      </Shell>
    );
  }

  if (step === "emailCode") {
    return (
      <Shell stepKey={step} onBack={() => go("welcome")}>
        <Title sub="We'll email you a 6-digit code. New here? We'll set up your account.">What&apos;s your email?</Title>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (emailOk) sendEmailCode();
          }}
        >
          <div className="mt-8">
            <TextInput autoFocus type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} aria-label="Email" placeholder="you@example.com" value={email} onChange={setEmail} maxLength={254} />
          </div>
          <ErrorText>{error}</ErrorText>
          <p className="mt-6 text-center text-xs leading-relaxed text-zinc-500">By continuing, you agree to our Terms of Service and Privacy Policy.</p>
          <Footer>
            <PrimaryButton type="submit" disabled={!emailOk} busy={busy}>
              Send code <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
            <button type="button" onClick={() => go("signin")} className="auth-alt-link text-sky-400 hover:underline">
              Use a password instead →
            </button>
          </Footer>
        </form>
      </Shell>
    );
  }

  if (step === "emailOtp") {
    return (
      <Shell stepKey={step} onBack={() => go("emailCode")}>
        <Title sub={`Sent to ${email.trim()}`}>Enter the code we just emailed you</Title>
        <CodeInput
          value={code}
          disabled={busy}
          onChange={(v) => {
            setCode(v);
            if (v.length === 6) verifyEmailCode(v);
          }}
        />
        <ErrorText>{error}</ErrorText>
        <div className="mt-6 text-center text-sm text-zinc-500">
          Didn&apos;t get it? Check spam, or{" "}
          {resendIn > 0 ? (
            <span>resend in {resendIn}s</span>
          ) : (
            <button onClick={sendEmailCode} className="font-semibold text-sky-400 hover:underline">
              tap to resend
            </button>
          )}
        </div>
        <Footer>
          <PrimaryButton onClick={() => verifyEmailCode(code)} disabled={code.length !== 6} busy={busy}>
            Verify <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  if (step === "signin" || step === "email") {
    // enabled as soon as both fields have text, so Enter / Go always gives feedback (validation message) instead of nothing
    const canSubmit = !!idTrim && (!!password || quickMatch);
    return (
      <Shell stepKey="signin" onBack={() => go("welcome")}>
        <Title sub="Use your email or screen name.">Welcome back!</Title>
        <form
          className="contents"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!idOk) return setError(idTrim ? "Enter a valid email or screen name (3–20 letters, numbers or _)." : "Enter your email or screen name.");
            if (quickMatch && !password) return void quickSignIn();
            if (!password) return setError("Enter your password.");
            void signIn();
          }}
        >
          <div className="mt-8 space-y-3">
            <TextInput
              autoFocus={!identifier}
              type="text"
              name="username"
              id="signin-identifier"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              aria-label="Email or screen name"
              placeholder="Email or screen name"
              value={identifier}
              onChange={(v) => {
                setIdentifier(v);
                setError(null);
              }}
              maxLength={254}
              data-testid="signin-identifier"
            />
            <PasswordInput
              autoFocus={!!identifier && !quickMatch}
              name="password"
              id="signin-password"
              autoComplete="current-password"
              enterKeyHint="go"
              aria-label="Password"
              placeholder={quickMatch ? "Password (optional)" : "Password"}
              value={password}
              onChange={(v) => {
                setPassword(v);
                setError(null);
              }}
              data-testid="signin-password"
            />
          </div>
          <div role="alert" aria-live="polite">
            <ErrorText>{error}</ErrorText>
          </div>
          <div className="mt-4 text-center">
            <a href={`/forgot-password${idTrim ? `?id=${encodeURIComponent(idTrim)}` : ""}`} className="text-sm font-semibold text-sky-400 hover:underline" data-testid="forgot-link">
              Forgot password?
            </a>
          </div>
          <Footer>
            {quickMatch && !password ? (
              <PrimaryButton type="submit" busy={busy}>
                <Fingerprint className="h-5 w-5" /> Sign in with Face ID / fingerprint
              </PrimaryButton>
            ) : (
              <PrimaryButton type="submit" disabled={!canSubmit} busy={busy}>
                Sign in <ArrowRight className="h-4 w-4" />
              </PrimaryButton>
            )}
            {parked && quickMatch && (
              <button
                type="button"
                onClick={() => {
                  void forgetParked();
                  setParked(null);
                  setIdentifier("");
                }}
                className="mt-3 w-full text-center text-xs text-zinc-500 hover:underline"
              >
                Not @{parked.username}? Forget this device
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                go("phone");
              }}
              className="mt-4 w-full text-center text-sm font-semibold text-sky-400 hover:underline"
            >
              Text me a code instead →
            </button>
            <button
              type="button"
              onClick={() => {
                if (idIsEmail) setEmail(idTrim);
                go("emailCode");
              }}
              className="mt-3 w-full text-center text-sm font-semibold text-sky-400 hover:underline"
            >
              Email me a code instead →
            </button>
            <button type="button" onClick={() => go("emailSignup")} className="mt-3 w-full text-center text-sm text-zinc-400 hover:underline">
              New here? Create an account with email →
            </button>
          </Footer>
        </form>
      </Shell>
    );
  }

  if (step === "emailSignup") {
    return (
      <Shell stepKey={step} onBack={() => go("signin")}>
        <Title sub="We'll email you a link to confirm it's you.">Sign up with email</Title>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (emailOk && password.length >= 8) emailSignUp();
          }}
        >
          <div className="mt-8 space-y-3">
            <TextInput autoFocus type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} aria-label="Email" placeholder="you@example.com" value={email} onChange={setEmail} maxLength={254} />
            <PasswordInput autoComplete="new-password" aria-label="Create a password" placeholder="Create a password" value={password} onChange={setPassword} />
            <p className={cn("px-1 text-xs", password && password.length < 8 ? "text-amber-400" : "text-zinc-500")}>At least 8 characters.</p>
          </div>
          <ErrorText>{error}</ErrorText>
          <Footer>
            <PrimaryButton type="submit" disabled={!emailOk || password.length < 8} busy={busy}>
              Create account <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
            <p className="mt-4 text-center text-xs leading-relaxed text-zinc-500">By signing up, you agree to our <Link href="/terms" className="underline hover:text-zinc-300">Terms of Use</Link> and <Link href="/privacy" className="underline hover:text-zinc-300">Privacy Policy</Link>.</p>
          </Footer>
        </form>
      </Shell>
    );
  }

  if (step === "emailSent") {
    return (
      <Shell stepKey={step} onBack={() => go("emailSignup")}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 text-6xl">📬</div>
          <h1 className="text-[26px] leading-tight font-bold tracking-tight">Check your inbox</h1>
          <p className="mt-3 max-w-xs text-[15px] leading-relaxed text-zinc-400">
            We sent a link to <span className="font-semibold text-zinc-200">{email.trim()}</span>. Tap it to confirm your email and pick your username.
          </p>
          <p className="mt-6 text-xs text-zinc-500">No email after a few minutes? Check spam, or go back and try again.</p>
        </div>
        <Footer>
          <PrimaryButton onClick={() => go("welcome")}>Done</PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  if (step === "code") {
    return (
      <Shell stepKey={step} onBack={() => go("phone")}>
        <Title sub={`Sent to ${phoneE164}`}>Enter the code we just texted you</Title>
        {demoCode && (
          <button
            onClick={() => {
              setCode(demoCode);
              verify(demoCode);
            }}
            className="mt-6 w-full rounded-2xl border border-dashed border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-left text-sm"
          >
            <span className="block text-xs font-semibold tracking-wide text-emerald-400 uppercase">Demo mode · no SMS sent</span>
            <span className="text-zinc-200">
              Your code is <b className="font-mono text-base tracking-[0.2em] text-emerald-300">{demoCode}</b> — tap to fill
            </span>
          </button>
        )}
        <CodeInput
          value={code}
          disabled={busy}
          onChange={(v) => {
            setCode(v);
            if (v.length === 6) verify(v);
          }}
        />
        <ErrorText>{error}</ErrorText>
        <div className="mt-6 text-center text-sm text-zinc-500">
          Didn&apos;t receive it?{" "}
          {resendIn > 0 ? (
            <span>Resend in {resendIn}s</span>
          ) : (
            <button type="button" onClick={sendCode} className="font-semibold text-sky-400 hover:underline">
              Tap to resend
            </button>
          )}
        </div>
        {smsTrouble && !linking && <EmailFallback onClick={() => go("emailCode")} />}
        <Footer>
          <PrimaryButton onClick={() => verify(code)} disabled={code.length !== 6} busy={busy}>
            Verify <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  if (step === "name") {
    return (
      <Shell stepKey={step}>
        <Title sub="People use real names on Open Lounge 🙂">What&apos;s your full name?</Title>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (firstName.trim()) {
              if (!username) setUsername(usernameIdeas[0] ?? "");
              go("username");
            }
          }}
        >
          <div className="mt-8 grid grid-cols-2 gap-3">
            <TextInput autoFocus placeholder="First" value={firstName} onChange={setFirstName} maxLength={24} autoComplete="given-name" />
            <TextInput placeholder="Last" value={lastName} onChange={setLastName} maxLength={24} autoComplete="family-name" />
          </div>
          <Footer>
            <PrimaryButton type="submit" disabled={!firstName.trim()}>
              Next <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
          </Footer>
        </form>
      </Shell>
    );
  }

  if (step === "username") {
    const ok = usernameState.available === true && !usernameState.checking;
    return (
      <Shell stepKey={step} onBack={() => go("name")}>
        <Title sub="This is how people find and mention you.">Pick a username</Title>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) go("photo");
          }}
        >
          <div className="mt-8 flex items-center rounded-2xl border border-white/10 bg-zinc-900 px-4 focus-within:border-emerald-500/60">
            <span className="text-xl text-zinc-500">@</span>
            <input
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
              placeholder="username"
              className="min-w-0 flex-1 bg-transparent px-1 py-3.5 text-xl outline-none placeholder:text-zinc-600"
            />
            {usernameState.checking ? (
              <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
            ) : ok ? (
              <Check className="h-5 w-5 text-emerald-400" />
            ) : null}
          </div>
          <p className={cn("mt-2 min-h-5 text-sm", ok ? "text-emerald-400" : "text-amber-400")}>
            {ok ? `@${username} is available` : usernameState.reason}
          </p>
          {usernameIdeas.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {usernameIdeas.map((idea) => (
                <button
                  type="button"
                  key={idea}
                  onClick={() => setUsername(idea)}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5"
                >
                  @{idea}
                </button>
              ))}
            </div>
          )}
          <ErrorText>{error}</ErrorText>
          <Footer>
            <PrimaryButton type="submit" disabled={!ok}>
              Next <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
          </Footer>
        </form>
      </Shell>
    );
  }

  if (step === "photo") {
    return (
      <Shell stepKey={step} onBack={() => go("username")}>
        <Title sub="A face (or a vibe) helps people recognize you on stage.">Great! Now add a photo?</Title>
        <PhotoPicker name={fullName} color={color} photo={photo} onPhoto={setPhoto} onError={setError} />
        <div className="mt-8">
          <span className="mb-2 block text-center text-sm text-zinc-400">{photo ? "Background color" : "Or pick a color"}</span>
          <div className="mx-auto grid max-w-xs grid-cols-5 gap-3">
            {AVATAR_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
                className={cn(
                  "openlounge-hex aspect-square transition-transform",
                  color === c ? "scale-110 ring-2 ring-white ring-offset-2 ring-offset-app" : "opacity-80 hover:opacity-100",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
        <Footer>
          <PrimaryButton onClick={() => go("bio")}>
            {photo ? "Looks great" : "Next"} <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  if (step === "bio") {
    return (
      <Shell stepKey={step} onBack={() => go("photo")}>
        <Title sub="Optional — you can always change it later.">Tell people a little about yourself</Title>
        <textarea
          autoFocus
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={280}
          rows={5}
          placeholder="Founder, musician, night owl… what are you into?"
          className="mt-8 w-full resize-none rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3 text-[15px] outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
        />
        <p className="mt-1 text-right text-xs text-zinc-500">{bio.length}/280</p>
        <ErrorText>{error}</ErrorText>
        <Footer>
          <PrimaryButton onClick={register} busy={busy} disabled={!connected}>
            {bio.trim() ? "Create my account" : "Skip & create account"} <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  if (step === "interests") {
    return (
      <Shell stepKey={step}>
        <Title sub="We'll use these to surface rooms you'll love.">Add your interests</Title>
        <InterestChips
          className="mt-8"
          selected={interests}
          onChange={setInterests}
        />
        <ErrorText>{error}</ErrorText>
        <Footer>
          <PrimaryButton onClick={() => saveInterests(interests)} busy={busy}>
            {interests.length ? `Next (${interests.length})` : "Skip"} <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </Footer>
      </Shell>
    );
  }

  // follow suggestions
  return (
    <Shell stepKey={step}>
      {suggestions !== null && suggestions.length === 0 ? (
        <Title sub="Rooms from people you follow will fill your hallway.">No one to follow yet</Title>
      ) : (
        <Title sub="Follow a few people to fill your hallway with rooms.">Here are some people we suggest you follow</Title>
      )}
      <ul className="mt-6 space-y-1">
        {(suggestions ?? []).map((u) => {
          const on = picked.has(u.id);
          return (
            <li key={u.id}>
              <button
                onClick={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (on) n.delete(u.id);
                    else n.add(u.id);
                    return n;
                  })
                }
                className="flex w-full items-center gap-3 rounded-2xl p-2.5 text-left hover:bg-white/5"
              >
                <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{u.name}</div>
                  <div className="truncate text-xs text-zinc-500">{u.bio}</div>
                </div>
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                    on ? "border-emerald-500 bg-emerald-500 text-on-accent" : "border-white/20",
                  )}
                >
                  {on && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {suggestions !== null && suggestions.length === 0 && (
        <div className="mt-2 rounded-3xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">
          <div className="mb-2 text-3xl">🌱</div>
          You&apos;re one of the first here. Invite a few friends, and they&apos;ll show up for you to follow.
        </div>
      )}
      <Footer>
        <PrimaryButton onClick={followAndFinish} busy={busy}>
          {picked.size ? `Follow ${picked.size} & enter the hallway` : "Enter the hallway"} <ArrowRight className="h-4 w-4" />
        </PrimaryButton>
      </Footer>
    </Shell>
  );
}

// ---------------- building blocks ----------------

/** reCAPTCHA + SMS send budget on the web (native shells have their own 120 s timeout). */
const SMS_SEND_TIMEOUT_MS = 25_000;
/** No text after this long on the code screen → also offer the email code. */
const SMS_WAIT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function EmailFallback({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="sms-email-fallback"
      className="mt-4 flex w-full items-center justify-center gap-2 rounded-full border border-white/10 py-3 text-[15px] font-semibold text-zinc-100 hover:bg-white/5"
    >
      <Mail className="h-4 w-4" /> Email me a code instead
    </button>
  );
}

/** Six boxes backed by one hidden input (works with SMS autofill / paste). */
function CodeInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="relative mt-8" onClick={() => ref.current?.focus()}>
      <input
        ref={ref}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Verification code"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="absolute inset-0 text-base opacity-0"
      />
      <div className="flex justify-center gap-2" aria-hidden>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "flex h-14 w-11 items-center justify-center rounded-xl border bg-zinc-900 font-mono text-2xl font-semibold",
              i === value.length ? "border-emerald-500" : "border-white/10",
            )}
          >
            {value[i] ?? ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function PhotoPicker({
  name,
  color,
  photo,
  onPhoto,
  onError,
}: {
  name: string;
  color: string;
  photo: string | null;
  onPhoto: (p: string | null) => void;
  onError: (e: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-8 flex flex-col items-center">
      <button onClick={() => ref.current?.click()} className="group relative" aria-label="Upload a photo">
        <Avatar name={name || "You"} color={color} photo={photo} size="xl" />
        <span className="absolute -right-1 -bottom-1 flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-on-accent ring-4 ring-app transition group-hover:scale-105">
          <Camera className="h-4 w-4" />
        </span>
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            onError(null);
            onPhoto(await fileToAvatarDataUrl(f));
          } catch (err) {
            onError((err as Error).message);
          }
        }}
      />
      {photo ? (
        <button onClick={() => onPhoto(null)} className="mt-3 text-sm text-zinc-500 hover:text-zinc-300">
          Remove photo
        </button>
      ) : (
        <span className="mt-3 text-sm text-zinc-500">Tap to upload</span>
      )}
    </div>
  );
}
