"use client";

// Clubhouse-style onboarding:
//   welcome → phone → code → (returning: hallway)
//                           → name → username → photo → bio → [account created] → interests → follow → hallway
// Phone verification goes through the server's OtpService (demo SMS provider by default).

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Check, Loader2 } from "lucide-react";
import { AVATAR_COLORS, USERNAME_RE, type PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fileToAvatarDataUrl } from "@/lib/image";
import { Avatar } from "../Avatar";
import { InterestChips } from "../profile/InterestChips";
import { useApp, type SessionPayload } from "../AppProvider";
import { COUNTRIES, formatNational } from "./countries";

type Step = "welcome" | "phone" | "code" | "name" | "username" | "photo" | "bio" | "interests" | "follow";

export function AuthFlow() {
  const { request, completeLogin, finishOnboarding, onboarding, follow, updateMe, connected, toast } = useApp();
  const [step, setStep] = useState<Step>(onboarding ? "interests" : "welcome");
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // phone + code
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [national, setNational] = useState("");
  const [phoneE164, setPhoneE164] = useState("");
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [ticket, setTicket] = useState("");

  // profile
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
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
    setBusy(true);
    setError(null);
    try {
      const res = await request<{ phone: string; demoCode?: string; resendIn: number }>("auth:requestCode", { phone: country.dial + digits });
      setPhoneE164(res.phone);
      setDemoCode(res.demoCode ?? null);
      setResendIn(res.resendIn);
      setCode("");
      go("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await request<({ status: "existing"; token: string } & SessionPayload) | { status: "new"; ticket: string }>("auth:verifyCode", {
        phone: phoneE164,
        code: value,
      });
      if (res.status === "existing") {
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
      if (/expired|start again/i.test((e as Error).message)) go("phone");
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
      setPicked(new Set(res.users.slice(0, 6).map((u) => u.id)));
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

  if (step === "welcome") {
    return (
      <Shell welcome stepKey={step}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 text-7xl">🎙️</div>
          <h1 className="text-3xl font-bold tracking-tight">Welcome to Open Lounge</h1>
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
          <PrimaryButton
            onClick={() => {
              setMode("signup");
              go("phone");
            }}
          >
            Get your username 👋
          </PrimaryButton>
          <button
            onClick={() => {
              setMode("signin");
              go("phone");
            }}
            className="mt-4 w-full text-center text-sm font-semibold text-sky-400 hover:underline"
          >
            Already have an account? Sign in →
          </button>
        </Footer>
      </Shell>
    );
  }

  if (step === "phone") {
    return (
      <Shell stepKey={step} onBack={() => go("welcome")}>
        <Title sub={mode === "signin" ? "We'll text you a code to sign back in." : undefined}>
          {mode === "signin" ? "Welcome back! What's your phone #?" : "Enter your phone #"}
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
          <p className="mt-6 text-center text-xs leading-relaxed text-zinc-500">
            By entering your number, you agree to our Terms of Service and Privacy Policy. We&apos;ll text you a 6-digit code.
          </p>
          <Footer>
            <PrimaryButton type="submit" disabled={digits.length < 6 || !connected} busy={busy}>
              Next <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
          </Footer>
        </form>
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
            <button onClick={sendCode} className="font-semibold text-sky-400 hover:underline">
              Tap to resend
            </button>
          )}
        </div>
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
      <Title sub="Follow a few people to fill your hallway with rooms.">Here are some people we suggest you follow</Title>
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
      <Footer>
        <PrimaryButton onClick={followAndFinish} busy={busy}>
          {picked.size ? `Follow ${picked.size} & enter the hallway` : "Enter the hallway"} <ArrowRight className="h-4 w-4" />
        </PrimaryButton>
      </Footer>
    </Shell>
  );
}

// ---------------- building blocks ----------------

function Shell({ children, onBack, stepKey, welcome }: { children: React.ReactNode; onBack?: () => void; stepKey: string; welcome?: boolean }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <div className="h-11">
        {onBack && (
          <button onClick={onBack} className="-ml-2 rounded-full p-2 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 active:scale-95" aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
      </div>
      <div key={stepKey} className={"flex flex-1 flex-col " + (welcome ? "auth-welcome-in" : "auth-step-in")}>
        {children}
      </div>
    </main>
  );
}

function Title({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="pt-6 text-center">
      <h1 className="text-[26px] leading-tight font-bold tracking-tight">{children}</h1>
      {sub && <p className="mt-2 text-[15px] text-zinc-400">{sub}</p>}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto pt-8 pb-[max(2rem,env(safe-area-inset-bottom))]">{children}</div>;
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  busy,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className="flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-4 text-[17px] font-semibold text-on-accent shadow-lg shadow-emerald-500/20 transition duration-200 hover:bg-emerald-400 active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : children}
    </button>
  );
}

function TextInput({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <input
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3.5 text-lg outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
    />
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-3 text-center text-sm text-red-400">{children}</p>;
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
        className="absolute inset-0 opacity-0"
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
