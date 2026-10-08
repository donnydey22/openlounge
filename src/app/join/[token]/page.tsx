"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, Users } from "lucide-react";
import type { InvitePreview } from "@/lib/groups";
import { friendlyMessage } from "@/lib/errors";
import { useApp } from "@/components/AppProvider";
import { Avatar } from "@/components/Avatar";
import { GroupScreen } from "@/components/groups/GroupScreen";

/** Invite link (openlounge.app/join/<token>): preview the group (photo, name, members), then one tap to join. */
export default function JoinGroupPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { request, connected } = useApp();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connected || preview) return;
    request<{ preview: InvitePreview }>("group:invitePreview", { token })
      .then((r) => setPreview(r.preview))
      .catch((e) => setError(friendlyMessage(e, "This invite link isn't valid anymore.")));
  }, [connected, preview, request, token]);

  const join = async () => {
    if (!preview || busy) return;
    if (preview.alreadyMember) return router.replace(`/messages/${preview.group.id}`);
    setBusy(true);
    try {
      const r = await request<{ groupId: string }>("group:join", { token });
      router.replace(`/messages/${r.groupId}`);
    } catch (e) {
      setError(friendlyMessage(e, "Couldn't join this group."));
      setBusy(false);
    }
  };

  const g = preview?.group;
  return (
    <GroupScreen title="Group invite" onBack={() => router.push("/messages")} testId="group-join">
      <div className="flex min-h-full flex-col items-center justify-center px-5 py-8">
        <div className="w-full max-w-sm rounded-3xl border border-white/5 bg-zinc-900/70 p-6 text-center shadow-xl">
          {!g && !error && (
            <div className="flex flex-col items-center gap-3 py-6" aria-busy="true">
              <div className="openlounge-hex h-[72px] w-[72px] animate-pulse bg-zinc-800" />
              <div className="h-4 w-36 animate-pulse rounded-full bg-zinc-800" />
            </div>
          )}
          {error && !g && (
            <div className="flex flex-col items-center gap-3 py-4 text-zinc-400" data-testid="join-error">
              <Users className="h-10 w-10 text-zinc-600" />
              <p>{error}</p>
            </div>
          )}
          {g && (
            <>
              <div className="flex justify-center">
                <Avatar name={g.title} color={g.color} photo={g.photoUrl} size="lg" />
              </div>
              <h1 className="mt-3 text-xl font-bold [overflow-wrap:anywhere]" data-testid="join-title">
                {g.title}
              </h1>
              <p className="mt-1 text-sm text-zinc-500">
                {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
              </p>
              {preview.sample.length > 0 && (
                <div className="mt-3 flex flex-wrap justify-center gap-1">
                  {preview.sample.map((s) => (
                    <Avatar key={s.id} name={s.name} color={s.color} photo={s.photoUrl} size="xs"/>
                  ))}
                </div>
              )}
              {g.description && <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-zinc-300 [overflow-wrap:anywhere]">{g.description}</p>}
              {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
              <button
                onClick={join}
                disabled={busy || (preview.full && !preview.alreadyMember)}
                className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-emerald-500 text-[15px] font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40"
                data-testid="join-button"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {preview.alreadyMember ? "Open chat" : preview.full ? "This group is full" : "Join group"}
              </button>
            </>
          )}
        </div>
      </div>
    </GroupScreen>
  );
}
