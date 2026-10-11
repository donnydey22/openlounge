"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, Ban, Flag, MessageCircle, Mic, MicOff, Sparkles, UserRound } from "lucide-react";
import type { Participant, UserProfile } from "@/lib/types";
import { compact } from "@/lib/utils";
import { Avatar } from "../Avatar";
import { Sheet } from "../Sheet";
import { useApp } from "../AppProvider";

export function UserActionSheet({
  target,
  roomId,
  canModerate,
  onClose,
  onMessage,
  onReport,
  onBlock,
  blocked,
}: {
  target: Participant | null;
  roomId: string;
  canModerate: boolean;
  onClose: () => void;
  /** Open a DM with this user without leaving the room */
  onMessage?: (userId: string) => void;
  /** App Store 1.2: report / block this participant */
  onReport?: (target: Participant) => void;
  onBlock?: (target: Participant) => void;
  blocked?: boolean;
}) {
  const { me, request, following, follow, toast, reportError } = useApp();
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    setProfile(null);
    if (!target) return;
    request<{ profile: UserProfile }>("user:get", { userId: target.userId })
      .then((r) => setProfile(r.profile))
      .catch(() => {});
  }, [target, request, following]);

  if (!target) return null;
  const isMe = target.userId === me?.id;
  const isFollowing = following.has(target.userId);

  const act = async (event: string, success?: string) => {
    try {
      await request(event, { roomId, userId: target.userId });
      if (success) toast(success);
      onClose();
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <Sheet open={!!target} onClose={onClose}>
      <div className="flex items-start gap-4">
        <Avatar name={target.name} color={target.color} photo={target.photoUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-semibold">
            {target.name} {isMe && <span className="text-sm font-normal text-zinc-500">(you)</span>}
          </h3>
          <div className="mt-0.5 flex gap-4 text-sm text-zinc-400">
            <span>
              <b className="text-zinc-100">{profile ? compact(profile.user.followers) : "–"}</b> {profile?.user.followers === 1 ? "follower" : "followers"}
            </span>
            <span>
              <b className="text-zinc-100">{profile ? compact(profile.user.following) : "–"}</b> following
            </span>
          </div>
          <p className="mt-2 line-clamp-3 text-sm text-zinc-300">{profile?.user.bio || (profile ? <span className="text-zinc-500">No bio yet.</span> : "…")}</p>
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        {!isMe && (
          <button
            onClick={() => follow(target.userId, !isFollowing)}
            className={
              "flex-1 rounded-full py-2.5 text-sm font-semibold transition " +
              (isFollowing ? "border border-white/15 text-zinc-200 hover:bg-white/5" : "bg-sky-500 text-on-color hover:bg-sky-400")
            }
          >
            {isFollowing ? "Following" : "Follow"}
          </button>
        )}
        {!isMe && onMessage && (
          <button
            onClick={() => onMessage(target.userId)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/15 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-white/5"
          >
            <MessageCircle className="h-4 w-4" /> Message
          </button>
        )}
        <Link
          href={`/profile/${target.userId}`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/15 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-white/5"
        >
          <UserRound className="h-4 w-4" /> Profile
        </Link>
      </div>

      {!isMe && !target.isBot && (onReport || onBlock) && (
        <div className="mt-4 flex gap-2">
          {onReport && (
            <button
              onClick={() => onReport(target)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-medium text-zinc-400 hover:bg-white/5 hover:text-red-400"
            >
              <Flag className="h-4 w-4" /> Report
            </button>
          )}
          {onBlock && (
            <button
              onClick={() => onBlock(target)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-medium text-zinc-400 hover:bg-white/5 hover:text-red-400"
            >
              <Ban className="h-4 w-4" /> {blocked ? "Unblock" : "Block"}
            </button>
          )}
        </div>
      )}

      {(canModerate || isMe) && (
        <div className="mt-5 space-y-1 border-t border-white/5 pt-4">
          {canModerate && !isMe && target.role === "listener" && (
            <ActionRow icon={<Mic className="h-4 w-4" />} label="Invite to speak" onClick={() => act("host:invite", `Invited ${target.name} to the stage`)} />
          )}
          {canModerate && !isMe && target.role === "speaker" && !target.muted && (
            <ActionRow icon={<MicOff className="h-4 w-4 text-red-400" />} label="Mute" onClick={() => act("host:mute", `🔇 Muted ${target.name}`)} />
          )}
          {(canModerate || isMe) && target.role !== "listener" && (
            <ActionRow
              icon={<Sparkles className="h-4 w-4 text-amber-400" />}
              label={isMe ? "Claim the podium" : "Give the podium"}
              onClick={() => act("podium:set", isMe ? "🎙 You're on the podium" : `🎙 ${target.name} holds the podium`)}
            />
          )}
          {((canModerate && !isMe) || isMe) && target.role === "speaker" && (
            <ActionRow
              icon={<ArrowDownToLine className="h-4 w-4" />}
              label={isMe ? "Move myself to audience" : "Move to audience"}
              onClick={() => act("stage:toAudience")}
            />
          )}
          {isMe && target.role === "host" && <p className="px-3 py-2 text-sm text-zinc-500">You&apos;re the host. Use the menu to end the room.</p>}
          {isMe && target.role === "listener" && <p className="px-3 py-2 text-sm text-zinc-500">Raise your hand to ask to speak.</p>}
        </div>
      )}
    </Sheet>
  );
}

function ActionRow({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={
        "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition hover:bg-white/5 " +
        (danger ? "text-red-400" : "text-zinc-100")
      }
    >
      {icon} {label}
    </button>
  );
}
