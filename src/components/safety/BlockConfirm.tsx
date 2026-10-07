"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Sheet } from "../Sheet";
import { setBlocked } from "@/lib/safety";

/** Confirm block / unblock. */
export function BlockConfirm({
  user,
  blocked,
  onClose,
  onDone,
}: {
  user: { id: string; name: string } | null;
  blocked: boolean;
  onClose: () => void;
  onDone?: (blocked: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return null;
  return (
    <Sheet open={!!user} onClose={onClose} title={blocked ? `Unblock ${user.name}?` : `Block ${user.name}?`}>
      <p className="text-sm leading-relaxed text-zinc-400">
        {blocked
          ? "They'll be able to message you and see you in suggestions again. You can block them again anytime."
          : "They won't be able to message you, you won't see their messages or chat, and you'll stop following each other. They aren't notified."}
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await setBlocked(user.id, !blocked);
            onDone?.(!blocked);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className={
          "mt-5 flex w-full items-center justify-center gap-2 rounded-full py-3.5 font-semibold disabled:opacity-40 " +
          (blocked ? "bg-emerald-500 text-on-accent hover:bg-emerald-400" : "bg-red-500 text-white hover:bg-red-400")
        }
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} {blocked ? "Unblock" : "Block"}
      </button>
      <button onClick={onClose} className="mt-2 w-full rounded-full py-3 text-sm font-medium text-zinc-400 hover:bg-white/5">
        Cancel
      </button>
    </Sheet>
  );
}
