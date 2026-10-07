"use client";

// Settings → "Ways to sign in": every method on this ONE account (phone, email + password, Apple, Google), plus
// buttons to add the missing ones. Whatever method is used later, it's the same profile, follows, rooms and DMs.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhoneSession } from "@/lib/firebaseClient";
import { ChevronRight, Loader2, Mail, Phone, Plus, X } from "lucide-react";
import { useApp } from "@/components/AppProvider";
import { Sheet } from "@/components/Sheet";
import { AppleLogo, GoogleLogo, useProviders } from "@/components/auth/ProviderButtons";
import { COUNTRIES, formatNational } from "@/components/auth/countries";
import { PasswordInput } from "@/components/auth/ui";
import { AuthFormError, SUGGEST_LINK_KEY, authGet, authPost, canUseOAuth, startLink, type OAuthProvider } from "@/lib/authApi";

interface Identity {
  id: string;
  provider: "phone" | "email" | "google" | "apple";
  label: string;
  privateRelay: boolean;
  verified: boolean;
  createdAt: number;
}

const NAMES = { phone: "Phone", email: "Email", google: "Google", apple: "Apple" } as const;

function MethodIcon({ provider }: { provider: Identity["provider"] }) {
  const cls = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800";
  if (provider === "phone") return <span className={cls}><Phone className="h-4 w-4 text-zinc-300" /></span>;
  if (provider === "email") return <span className={cls}><Mail className="h-4 w-4 text-zinc-300" /></span>;
  if (provider === "google") return <span className={cls}><GoogleLogo className="h-4 w-4" /></span>;
  return <span className={cls}><AppleLogo className="h-4 w-[14px] text-zinc-100" /></span>;
}

export function SignInMethods() {
  const { toast, request } = useApp();
  const flags = useProviders();
  const [items, setItems] = useState<Identity[] | null>(null);
  const [sheet, setSheet] = useState<null | "phone" | "email">(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await authGet<{ identities: Identity[] }>("/auth/identities", { auth: true });
    if (r?.identities) setItems(r.identities);
  }, []);

  useEffect(() => {
    void load();
    const linked = new URLSearchParams(location.search).get("linked");
    if (linked && linked in NAMES) {
      toast(`✅ ${NAMES[linked as keyof typeof NAMES]} connected — you can sign in with it now`);
      history.replaceState(null, "", "/settings");
    }
  }, [load, toast]);

  const has = (p: Identity["provider"]) => !!items?.some((i) => i.provider === p);
  const oauth = canUseOAuth();

  // gentle prompt after a phone sign-in: "Add Google or Apple to sign in faster" (until dismissed or done)
  const [suggest, setSuggest] = useState(false);
  useEffect(() => {
    try {
      setSuggest(localStorage.getItem(SUGGEST_LINK_KEY) === "1");
    } catch {
      /* storage disabled */
    }
  }, []);
  const dismissSuggest = () => {
    setSuggest(false);
    try {
      localStorage.setItem(SUGGEST_LINK_KEY, "dismissed");
    } catch {
      /* storage disabled */
    }
  };
  const canSuggest = !!items && oauth && ((flags?.google && !has("google")) || (flags?.apple && !has("apple")));
  const showSuggest = suggest && canSuggest && !has("google") && !has("apple");

  async function remove(i: Identity) {
    if (!confirm(`Remove ${NAMES[i.provider]} (${i.label}) as a way to sign in?`)) return;
    setBusy(i.id);
    try {
      const r = await authPost<{ identities: Identity[] }>("/auth/identities/remove", { id: i.id }, { auth: true });
      setItems(r.identities);
      toast(`${NAMES[i.provider]} removed`);
    } catch (e) {
      toast(e instanceof AuthFormError ? e.message : "Couldn't remove that right now");
    } finally {
      setBusy(null);
    }
  }

  async function connect(p: OAuthProvider) {
    setBusy(p);
    try {
      dismissSuggest();
      await startLink(p);
    } catch (e) {
      toast(e instanceof AuthFormError ? e.message : "Couldn't start that right now");
    } finally {
      setTimeout(() => setBusy(null), 4000);
    }
  }

  const row = "flex w-full items-center gap-3 border-t border-white/5 px-4 py-3 text-left text-sm first:border-t-0 hover:bg-white/5";
  return (
    <section className="mb-8" data-testid="signin-methods">
      <h2 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Linked sign-in methods</h2>
      <p className="mb-3 text-sm text-zinc-400">All of these open this same account — your profile, follows and messages.</p>
      {showSuggest && (
        <div className="mb-3 flex items-start gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm" data-testid="suggest-link">
          <div className="flex-1">
            <div className="font-semibold text-zinc-100">Add Google or Apple to sign in faster</div>
            <div className="mt-0.5 text-zinc-400">Skip the text code next time. It&apos;s still this same account.</div>
          </div>
          <button onClick={dismissSuggest} aria-label="Not now" className="rounded-full p-1 text-zinc-400 hover:bg-white/5">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
        {items === null && (
          <div className="flex items-center justify-center px-4 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
          </div>
        )}
        {items?.map((i) => (
          <div key={i.id} className={row.replace(" hover:bg-white/5", "")}>
            <MethodIcon provider={i.provider} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{NAMES[i.provider]}</div>
              <div className="truncate text-xs text-zinc-500">{i.privateRelay ? "Hidden email (Apple relay)" : i.label}</div>
            </div>
            {items.length > 1 && (
              <button onClick={() => remove(i)} disabled={busy === i.id} className="rounded-full px-3 py-1 text-xs font-semibold text-zinc-400 hover:bg-white/5 hover:text-red-400">
                {busy === i.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Remove"}
              </button>
            )}
          </div>
        ))}
        {items && !has("phone") && (
          <button className={row} onClick={() => setSheet("phone")}>
            <Plus className="h-4 w-4 text-zinc-400" /> <span className="flex-1">Add phone number</span> <ChevronRight className="h-4 w-4 text-zinc-500" />
          </button>
        )}
        {items && flags?.email && !has("email") && (
          <button className={row} onClick={() => setSheet("email")}>
            <Plus className="h-4 w-4 text-zinc-400" /> <span className="flex-1">Add email</span> <ChevronRight className="h-4 w-4 text-zinc-500" />
          </button>
        )}
        {items && flags?.apple && oauth && !has("apple") && (
          <button className={row} onClick={() => connect("apple")} disabled={busy === "apple"}>
            <AppleLogo className="h-4 w-[14px]" /> <span className="flex-1">Connect Apple</span>
            {busy === "apple" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
          </button>
        )}
        {items && flags?.google && oauth && !has("google") && (
          <button className={row} onClick={() => connect("google")} disabled={busy === "google"}>
            <GoogleLogo className="h-4 w-4" /> <span className="flex-1">Connect Google</span>
            {busy === "google" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
          </button>
        )}
      </div>

      <Sheet open={sheet === "phone"} onClose={() => setSheet(null)} title="Add phone number">
        <AddPhone
          request={request}
          onDone={() => {
            setSheet(null);
            void load();
            toast("✅ Phone number added");
          }}
        />
      </Sheet>
      <Sheet open={sheet === "email"} onClose={() => setSheet(null)} title="Add email">
        <AddEmailCode
          onDone={() => {
            setSheet(null);
            void load();
            toast("✅ Email added — you can sign in with it now");
          }}
        />
      </Sheet>
    </section>
  );
}

function AddPhone({ request, onDone }: { request: <T>(ev: string, payload?: unknown) => Promise<T>; onDone: () => void }) {
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [national, setNational] = useState("");
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [demo, setDemo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = national.replace(/\D/g, "");
  // real phone verification (Firebase) when the server has it on; the demo code flow otherwise
  const [firebase, setFirebase] = useState(false);
  const confirmation = useRef<PhoneSession | null>(null);
  useEffect(() => {
    request<{ firebase?: boolean }>("auth:config")
      .then((c) => setFirebase(!!c.firebase))
      .catch(() => setFirebase(false));
  }, [request]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      if (firebase) {
        const e164 = country.dial + digits;
        const { sendPhoneCode } = await import("@/lib/firebaseClient");
        confirmation.current = await sendPhoneCode(e164, "recaptcha-link-phone");
        setPhone(e164);
        setDemo(null);
        return;
      }
      const r = await request<{ phone: string; demoCode?: string }>("auth:requestCode", { phone: country.dial + digits });
      setPhone(r.phone);
      setDemo(r.demoCode ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError(null);
    try {
      if (firebase && confirmation.current) {
        const { confirmPhoneCode } = await import("@/lib/firebaseClient");
        const idToken = await confirmPhoneCode(confirmation.current, code);
        await request("account:linkPhoneFirebase", { idToken }); // links the verified number to THIS member
      } else await request("account:linkPhone", { phone, code });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const input = "w-full rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3.5 text-lg outline-none placeholder:text-zinc-600 focus:border-emerald-500/60";
  return (
    <div>
      {!phone ? (
        <>
          <p className="mb-4 text-sm text-zinc-400">We&apos;ll text you a 6-digit code. Afterwards you can sign in with this number too.</p>
          <div className="flex gap-2">
            <select aria-label="Country code" value={country.code} onChange={(e) => setCountry(COUNTRIES.find((c) => c.code === e.target.value) ?? COUNTRIES[0])} className="rounded-2xl border border-white/10 bg-zinc-900 px-3 text-[15px]">
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.dial}
                </option>
              ))}
            </select>
            <input inputMode="tel" autoComplete="tel-national" aria-label="Phone number" placeholder={country.placeholder} value={formatNational(national, country.code)} onChange={(e) => setNational(e.target.value.replace(/\D/g, "").slice(0, 14))} className={input} />
          </div>
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-zinc-400">Enter the code we sent to {phone}.{demo ? ` (Demo code: ${demo})` : ""}</p>
          <input inputMode="numeric" autoComplete="one-time-code" aria-label="Verification code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className={input + " text-center font-mono tracking-[0.4em]"} />
        </>
      )}
      {error && <p className="mt-3 text-center text-sm text-red-400">{error}</p>}
      <button
        disabled={busy || (!phone ? digits.length < 6 : code.length !== 6)}
        onClick={() => (phone ? verify() : send())}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {phone ? "Verify & add" : "Send code"}
      </button>
    </div>
  );
}

function AddEmail() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && password.length >= 8;

  if (sent)
    return (
      <div className="py-4 text-center">
        <div className="mb-3 text-5xl">📬</div>
        <p className="text-sm text-zinc-400">
          Check <span className="font-semibold text-zinc-200">{email.trim()}</span> and tap the link to finish adding it.
        </p>
      </div>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        setBusy(true);
        setError(null);
        try {
          await authPost("/auth/email/link", { email: email.trim(), password }, { auth: true });
          setSent(true);
        } catch (err) {
          setError(err instanceof AuthFormError ? err.message : "Something went wrong. Please try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="mb-4 text-sm text-zinc-400">Sign in with this email and password on any device. We&apos;ll email you a link to confirm it.</p>
      <div className="space-y-3">
        <input type="email" inputMode="email" autoComplete="email" autoCapitalize="none" aria-label="Email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3.5 text-lg outline-none placeholder:text-zinc-600 focus:border-emerald-500/60" />
        <PasswordInput autoComplete="new-password" aria-label="Password" placeholder="Password (8+ characters)" value={password} onChange={setPassword} />
      </div>
      {error && <p className="mt-3 text-center text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={!ok || busy} className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40">
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Send confirmation link
      </button>
    </form>
  );
}

/** Settings → Add email: 6-digit code to that inbox, then it's a verified sign-in method on THIS account. */
function AddEmailCode({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [usePassword, setUsePassword] = useState(false);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const input = "w-full rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3.5 text-lg outline-none placeholder:text-zinc-600 focus:border-emerald-500/60";
  if (usePassword) return <AddEmail />;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await authPost<{ resendIn: number }>("/auth/email/code/link/start", { email: email.trim() }, { auth: true });
      setSent(true);
      setCode("");
      setResendIn(r.resendIn ?? 60);
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await authPost("/auth/email/code/link/verify", { email: email.trim(), code }, { auth: true });
      onDone();
    } catch (e) {
      setError(e instanceof AuthFormError ? e.message : "Something went wrong. Please try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {!sent ? (
        <>
          <p className="mb-4 text-sm text-zinc-400">We&apos;ll email you a 6-digit code. Afterwards you can sign in with this email too — it&apos;s still this same account.</p>
          <input type="email" inputMode="email" autoComplete="email" autoCapitalize="none" aria-label="Email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-zinc-400">Enter the code we sent to <span className="font-semibold text-zinc-200">{email.trim()}</span>.</p>
          <input inputMode="numeric" autoComplete="one-time-code" aria-label="Verification code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className={input + " text-center font-mono tracking-[0.4em]"} />
          <div className="mt-3 text-center text-sm text-zinc-500">
            {resendIn > 0 ? <span>Resend in {resendIn}s</span> : <button onClick={send} className="font-semibold text-sky-400 hover:underline">Resend code</button>}
          </div>
        </>
      )}
      {error && <p className="mt-3 text-center text-sm text-red-400">{error}</p>}
      <button
        disabled={busy || (!sent ? !emailOk : code.length !== 6)}
        onClick={() => (sent ? verify() : send())}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {sent ? "Verify & add" : "Send code"}
      </button>
      {!sent && (
        <button type="button" onClick={() => setUsePassword(true)} className="mt-4 w-full text-center text-sm font-semibold text-sky-400 hover:underline">
          Add email & password instead →
        </button>
      )}
    </div>
  );
}
