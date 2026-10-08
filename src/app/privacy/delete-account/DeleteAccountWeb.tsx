"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Trash2 } from "lucide-react";
import { authFetch, logout, validateStoredSession } from "@/lib/auth";

/** Signed in → delete right here (same API as Settings > Delete account). Signed out → link to sign in. */
export function DeleteAccountWeb() {
  const [who, setWho] = useState<{ name: string; username: string } | null | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    validateStoredSession()
      .then((s) => setWho(s ? { name: s.user.name, username: s.user.username } : null))
      .catch(() => setWho(null));
  }, []);

  async function del() {
    if (typed.trim().toUpperCase() !== "DELETE" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/me/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "DELETE" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not delete your account");
      await logout().catch(() => {});
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete your account");
    } finally {
      setBusy(false);
    }
  }

  const box = "my-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4";
  if (done) return <div className={box} data-testid="delete-done">Your account has been deleted. Thanks for trying Open Lounge.</div>;
  if (who === undefined)
    return (
      <div className={box}>
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
      </div>
    );
  if (!who)
    return (
      <div className={box}>
        <Link href="/settings" className="font-semibold text-sky-400 hover:underline">
          Sign in
        </Link>{" "}
        and open Settings &gt; Delete account, or use the email option below.
      </div>
    );
  return (
    <div className={box}>
      <p className="mb-3">
        Signed in as <b>{who.name}</b> (@{who.username}). Type <b>DELETE</b> to permanently delete this account.
      </p>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder="DELETE"
        autoCapitalize="characters"
        className="mb-3 w-full rounded-xl border border-white/10 bg-zinc-950 px-3 py-2.5 text-base text-zinc-100"
        aria-label="Type DELETE to confirm"
      />
      {error && <p className="mb-2 text-red-400">{error}</p>}
      <button
        onClick={del}
        disabled={busy || typed.trim().toUpperCase() !== "DELETE"}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-red-500 py-3 font-semibold text-white disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete my account
      </button>
    </div>
  );
}
