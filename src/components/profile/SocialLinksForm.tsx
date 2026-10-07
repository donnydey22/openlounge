"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth";
import type { Me } from "@/lib/types";
import { SOCIAL_KEYS, SOCIAL_LABELS, SOCIAL_SPECS, socialFormState, type SocialKey, type SocialLinks } from "@/lib/socialLinks";
import { SocialIcon } from "./SocialLinks";

type Draft = Record<SocialKey, string>;
const toDraft = (l?: SocialLinks): Draft => Object.fromEntries(SOCIAL_KEYS.map((k) => [k, l?.[k] ?? ""])) as Draft;

/** Settings → Social links. Validates client-side (same rules as the server) and saves via REST. */
export function SocialLinksForm({ me, onSaved, toast }: { me: Me | null; onSaved: (u: Me) => void; toast: (m: string) => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(me?.socialLinks));
  const [serverErrors, setServerErrors] = useState<Partial<Record<SocialKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const saved = useMemo(() => toDraft(me?.socialLinks), [me?.socialLinks]);

  useEffect(() => {
    if (!touched) setDraft(saved);
  }, [saved, touched]);

  // NOTE: the old version merged `{ [k]: undefined }` server-error entries into `errors` on every keystroke,
  // so Object.keys(errors).length was always > 0 and Save stayed disabled with no visible message.
  const { errors, canSave } = useMemo(() => socialFormState(draft, saved, serverErrors), [draft, saved, serverErrors]);
  const [showErrors, setShowErrors] = useState<Partial<Record<SocialKey, boolean>>>({});

  const save = async () => {
    setBusy(true);
    setServerErrors({});
    try {
      const links = Object.fromEntries(SOCIAL_KEYS.map((k) => [k, draft[k].trim() || null]));
      const res = await authFetch("/api/me/social-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        if (body.errors) setServerErrors(body.errors);
        toast(body.error ?? "Couldn't save links");
        return;
      }
      onSaved(body.user);
      setTouched(false);
      setDraft(toDraft(body.user.socialLinks));
      toast("Social links saved");
    } catch {
      toast("Couldn't reach the server — try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-8 scroll-mb-24">
      <h2 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Social links</h2>
      <p className="mb-3 text-sm text-zinc-400">Shown on your profile. Enter a handle or paste a link; leave blank to remove.</p>
      <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
        {SOCIAL_KEYS.map((k, i) => (
          <label key={k} className={"flex items-center gap-3 px-4 py-2.5 " + (i ? "border-t border-white/5" : "")}>
            <SocialIcon k={k} className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="w-24 shrink-0 text-sm">{SOCIAL_LABELS[k]}</span>
            <span className="min-w-0 flex-1">
              <input
                value={draft[k]}
                onChange={(e) => {
                  setTouched(true);
                  setServerErrors(({ [k]: _drop, ...rest }) => rest);
                  setDraft((d) => ({ ...d, [k]: e.target.value }));
                }}
                onInput={(e) => {
                  // Some WebViews fire input without React's synthetic change; keep state in sync.
                  const v = (e.target as HTMLInputElement).value;
                  setDraft((d) => (d[k] === v ? d : { ...d, [k]: v }));
                }}
                onBlur={() => setShowErrors((s) => ({ ...s, [k]: true }))}
                name={`social-${k}`}
                type="text"
                autoComplete="off"
                enterKeyHint="done"
                maxLength={200}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={k === "website" ? "https://example.com" : SOCIAL_SPECS[k].placeholder}
                aria-invalid={!!errors[k]}
                aria-describedby={errors[k] ? `social-${k}-err` : undefined}
                className="w-full bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
              />
              {errors[k] && (showErrors[k] || draft[k].trim().length > 2 || serverErrors[k]) && (
                <span id={`social-${k}-err`} role="alert" className="mt-0.5 block text-xs text-red-400">
                  {errors[k]}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      <button
        type="button"
        data-testid="social-save"
        disabled={busy || !canSave}
        onClick={save}
        className="relative z-10 mt-3 mb-[env(safe-area-inset-bottom)] flex min-h-12 w-full touch-manipulation scroll-mb-24 items-center justify-center gap-2 rounded-full bg-emerald-500 py-3 font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Saving…" : "Save links"}
      </button>
      {!busy && Object.keys(errors).length > 0 && (
        <p className="mt-2 text-center text-xs text-red-400">Fix the highlighted field{Object.keys(errors).length > 1 ? "s" : ""} to save.</p>
      )}
    </section>
  );
}
