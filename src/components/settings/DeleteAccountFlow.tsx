"use client";
// Telegram-style account deletion (store compliance): explain → re-verify identity → final red confirm → immediate.
// Used by Settings > Account > Delete account and the public page /privacy/delete-account.
import { useEffect, useState } from "react";
import { Check, Fingerprint, KeyRound, Loader2, Mail, Phone, ShieldAlert, Trash2, X } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { biometricAuthenticate, biometricsBridge } from "@/lib/biometrics";
import { confirmPhoneCode, sendPhoneCode, type PhoneSession } from "@/lib/firebaseClient";

type Options = {
  password: boolean;
  emails: { email: string; masked: string }[];
  phone: { masked: string } | null;
  recent: boolean;
  device: boolean;
  providers: string[];
};
type Step = "explain" | "verify" | "confirm";
type Method = "password" | "email" | "phone" | "device" | "recent";

async function post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const r = await authFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!r.ok || j.ok === false) throw new Error(j.error || "Something went wrong. Try again.");
  return j;
}

export const DELETED_ITEMS = [
  "Your phone number, email, password and Google/Apple sign-in links",
  "Your name, username, photo, bio, interests and social links (your username becomes available to others later)",
  "Who you follow and who follows you, and your blocks",
  "Your sessions and push-notification tokens, so you're signed out on every device",
  "Your uploaded contact codes and your “Tell me when contacts join” setting",
  "Rooms you're hosting are ended",
];
export const KEPT_ITEMS = [
  "Messages you already sent stay in the other person's chat, shown as from “Deleted Account”",
  "Reports about content that broke our rules, kept for safety and legal reasons",
];

export function DeleteAccountFlow({ onDeleted, onCancel }: { onDeleted: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState<Step>("explain");
  const [opts, setOpts] = useState<Options | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [phoneSession, setPhoneSession] = useState<PhoneSession | null>(null);
  const [reauth, setReauth] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bio = typeof window !== "undefined" ? biometricsBridge() : null;

  useEffect(() => {
    if (step !== "verify" || opts) return;
    authFetch("/api/me/delete/options")
      .then((r) => r.json())
      .then((j) => {
        setOpts(j);
        if (j.emails?.[0]) setEmail(j.emails[0].email);
        setMethod(j.device && bio ? "device" : j.password ? "password" : j.phone ? "phone" : j.emails?.length ? "email" : j.recent ? "recent" : null);
      })
      .catch(() => setError("Couldn't load your sign-in methods. Check your connection."));
  }, [step, opts, bio]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verified = (token: string) => {
    setReauth(token);
    setStep("confirm");
  };

  const verify = () =>
    run(async () => {
      if (method === "password") verified((await post<{ reauth: string }>("/api/me/delete/verify", { method, password })).reauth);
      else if (method === "email") {
        if (!sent) {
          await post("/api/me/delete/email/start", { email });
          setSent(true);
          return;
        }
        verified((await post<{ reauth: string }>("/api/me/delete/verify", { method, email, code })).reauth);
      } else if (method === "phone") {
        if (!phoneSession) {
          const e164 = phone.trim().replace(/[^\d+]/g, "");
          if (!/^\+\d{8,15}$/.test(e164)) throw new Error("Enter your number with the country code, like +1 555 123 4567.");
          setPhoneSession(await sendPhoneCode(e164, "delete-account"));
          return;
        }
        const idToken = await confirmPhoneCode(phoneSession, code.trim());
        verified((await post<{ reauth: string }>("/api/me/delete/verify", { method, idToken })).reauth);
      } else if (method === "device") {
        if (!(await biometricAuthenticate(bio))) throw new Error("Face ID / fingerprint didn't confirm. Try again or use another method.");
        verified((await post<{ reauth: string }>("/api/me/delete/verify", { method })).reauth);
      } else if (method === "recent") verified((await post<{ reauth: string }>("/api/me/delete/verify", { method })).reauth);
    });

  const del = () =>
    run(async () => {
      await post("/api/me/delete", { confirm: "DELETE", reauth });
      onDeleted();
    });

  const tab = (m: Method, label: string, Icon: typeof Mail) => (
    <button
      key={m}
      onClick={() => (setMethod(m), setError(null), setCode(""), setSent(false), setPhoneSession(null))}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${method === m ? "border-red-400/50 bg-red-500/10 text-red-300" : "border-white/10 text-zinc-400"}`}
      data-testid={`delete-method-${m}`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
  const field = "mb-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-base text-zinc-100";

  if (step === "explain")
    return (
      <div data-testid="delete-explain">
        <p className="mb-3 text-sm text-zinc-300">Deleting your account is permanent and happens right away. It can&apos;t be undone.</p>
        <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Deleted</h3>
        <ul className="mb-4 space-y-1.5 text-sm text-zinc-300">
          {DELETED_ITEMS.map((t) => (
            <li key={t} className="flex gap-2">
              <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" /> {t}
            </li>
          ))}
        </ul>
        <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Kept</h3>
        <ul className="mb-5 space-y-1.5 text-sm text-zinc-400">
          {KEPT_ITEMS.map((t) => (
            <li key={t} className="flex gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" /> {t}
            </li>
          ))}
        </ul>
        <button onClick={() => setStep("verify")} className="w-full rounded-xl bg-red-600/90 px-4 py-3 text-sm font-semibold text-white" data-testid="delete-continue">
          Continue
        </button>
        {onCancel && (
          <button onClick={onCancel} className="mt-2 w-full rounded-xl py-2.5 text-sm text-zinc-400">
            Cancel
          </button>
        )}
      </div>
    );

  if (step === "verify")
    return (
      <div data-testid="delete-verify">
        <p className="mb-3 flex items-start gap-2 text-sm text-zinc-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /> First, confirm it&apos;s really you.
        </p>
        {!opts ? (
          <Loader2 className="my-4 h-5 w-5 animate-spin text-zinc-500" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {opts.device && bio && tab("device", "Face ID / fingerprint", Fingerprint)}
              {opts.password && tab("password", "Password", KeyRound)}
              {opts.phone && tab("phone", "Phone code", Phone)}
              {opts.emails.length > 0 && tab("email", "Email code", Mail)}
              {opts.recent && tab("recent", "I just signed in", Check)}
            </div>
            {method === "password" && (
              <input type="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} data-testid="delete-password" />
            )}
            {method === "email" && (
              <>
                {opts.emails.length > 1 ? (
                  <select value={email} onChange={(e) => setEmail(e.target.value)} className={field}>
                    {opts.emails.map((e) => (
                      <option key={e.email} value={e.email}>
                        {e.masked}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="mb-2 text-sm text-zinc-400">We&apos;ll email a 6-digit code to {opts.emails[0]?.masked}.</p>
                )}
                {sent && <input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} className={field} />}
              </>
            )}
            {method === "phone" && (
              <>
                <p className="mb-2 text-sm text-zinc-400">Enter the number on your account ({opts.phone?.masked}) and we&apos;ll text you a code.</p>
                <input type="tel" autoComplete="tel" placeholder="+1 555 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!!phoneSession} className={field} />
                {phoneSession && <input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} className={field} />}
              </>
            )}
            {method === "device" && <p className="mb-3 text-sm text-zinc-400">Confirm with Face ID, fingerprint or your phone&apos;s passcode.</p>}
            {method === "recent" && <p className="mb-3 text-sm text-zinc-400">You signed in a few minutes ago, so that counts as confirmation.</p>}
            {!method && (
              <p className="mb-3 text-sm text-zinc-400">
                For your security, sign out and sign back in, then come back here within 10 minutes. If you can&apos;t sign in, email support.
              </p>
            )}
          </>
        )}
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        {method && (
          <button onClick={verify} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-900 disabled:opacity-40" data-testid="delete-verify-btn">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {(method === "email" && !sent) || (method === "phone" && !phoneSession) ? "Send code" : "Confirm it's me"}
          </button>
        )}
      </div>
    );

  return (
    <div data-testid="delete-confirm">
      <p className="mb-2 text-base font-semibold text-zinc-100">Delete your account forever?</p>
      <p className="mb-5 text-sm text-zinc-400">This happens immediately. You&apos;ll be signed out everywhere and your account can&apos;t be recovered.</p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <button onClick={del} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-40" data-testid="delete-final">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete my account
      </button>
      {onCancel && (
        <button onClick={onCancel} disabled={busy} className="mt-2 w-full rounded-xl py-2.5 text-sm text-zinc-400">
          Keep my account
        </button>
      )}
    </div>
  );
}
