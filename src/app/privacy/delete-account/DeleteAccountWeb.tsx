"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { logout, validateStoredSession } from "@/lib/auth";
import { DeleteAccountFlow } from "@/components/settings/DeleteAccountFlow";

/** Signed in → the same explain → re-verify → confirm flow as Settings > Account > Delete account. Signed out → sign in or email. */
export function DeleteAccountWeb() {
  const [who, setWho] = useState<{ name: string; username: string } | null | undefined>(undefined);
  const [done, setDone] = useState(false);

  useEffect(() => {
    validateStoredSession()
      .then((s) => setWho(s ? { name: s.user.name, username: s.user.username } : null))
      .catch(() => setWho(null));
  }, []);

  const box = "my-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4";
  if (done) return <div className={box} data-testid="delete-done">Your Open Lounge account has been deleted. Thanks for trying Open Lounge.</div>;
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
        and open Settings &gt; Account &gt; Delete account, or use the email option below.
      </div>
    );
  return (
    <div className={box}>
      <p className="mb-3">
        Signed in as <b>{who.name}</b> (@{who.username}).
      </p>
      <DeleteAccountFlow
        onDeleted={() => {
          void logout().catch(() => {});
          setDone(true);
        }}
      />
    </div>
  );
}
