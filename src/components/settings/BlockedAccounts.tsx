"use client";

import { useState } from "react";
import Link from "next/link";
import { Ban, ChevronRight } from "lucide-react";
import { Avatar } from "../Avatar";
import { Sheet } from "../Sheet";
import { BlockConfirm } from "../safety/BlockConfirm";
import { useSafety } from "@/lib/safety";

/** Settings > Blocked accounts (App Store 1.2). */
export function BlockedAccounts({ meId, toast }: { meId: string | undefined; toast: (m: string) => void }) {
  const { blocked, loaded } = useSafety(meId);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 border-t border-white/5 px-4 py-3 text-left text-sm hover:bg-white/5"
        data-testid="blocked-accounts"
      >
        <Ban className="h-4 w-4 text-zinc-400" />
        <span className="flex-1">
          Blocked accounts
          {blocked.length ? <span className="ml-2 text-xs text-zinc-500">{blocked.length}</span> : null}
        </span>
        <ChevronRight className="h-4 w-4 text-zinc-500" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Blocked accounts">
        <p className="mb-4 text-sm text-zinc-400">Blocked accounts can&apos;t message you, and you won&apos;t see their messages or room chat. They aren&apos;t notified.</p>
        {!loaded ? (
          <div className="skeleton h-14 w-full rounded-2xl" />
        ) : blocked.length === 0 ? (
          <div className="py-8 text-center text-sm text-zinc-500">
            <div className="mb-2 text-3xl">🕊️</div>
            You haven&apos;t blocked anyone.
          </div>
        ) : (
          <ul className="space-y-1">
            {blocked.map((u) => (
              <li key={u.id} className="flex items-center gap-3 rounded-2xl px-2 py-2 hover:bg-white/5">
                <Link href={`/profile/${u.id}`} onClick={() => setOpen(false)} className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{u.name}</div>
                    <div className="truncate text-xs text-zinc-500">@{u.username}</div>
                  </div>
                </Link>
                <button
                  onClick={() => setTarget({ id: u.id, name: u.name })}
                  className="shrink-0 rounded-full border border-white/15 px-4 py-1.5 text-sm font-semibold text-zinc-200 hover:bg-white/5"
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
      <BlockConfirm user={target} blocked onClose={() => setTarget(null)} onDone={() => target && toast(`Unblocked ${target.name}`)} />
    </>
  );
}
