"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { authFetch } from "@/lib/auth";

/** Settings > Delete account (App Store guideline 5.1.1(v)): two-step confirm, then POST /api/me/delete. */
export function DeleteAccount({ onDeleted, toast }: { onDeleted: () => void; toast: (msg: string) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = typed.trim().toUpperCase() === "DELETE";

  async function confirmDelete() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch("/api/me/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "Could not delete your account");
      setOpen(false);
      toast("Your account was deleted");
      onDeleted();
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete your account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Account</h2>
      <div className="overflow-hidden rounded-2xl border border-white/5 bg-white/[0.03]">
        <button
          onClick={() => {
            setTyped("");
            setError(null);
            setOpen(true);
          }}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-red-400 hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" /> Delete account
        </button>
      </div>
      <Sheet open={open} onClose={() => !busy && setOpen(false)} title="Delete account?">
        <p className="mb-3 text-sm text-zinc-400">
          This permanently deletes your profile, sign-in methods, follows, notification settings, device tokens and contact matches, and
          signs you out everywhere. Messages you sent stay with the other person but show as &ldquo;Deleted account&rdquo;. This can&apos;t be
          undone.
        </p>
        <label className="mb-1 block text-xs text-zinc-500" htmlFor="delete-confirm">
          Type DELETE to confirm
        </label>
        <input
          id="delete-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          className="mb-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          disabled={!ready || busy}
          onClick={confirmDelete}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Permanently delete my account
        </button>
      </Sheet>
    </section>
  );
}
