import Link from "next/link";
import { MessageCircle, User } from "lucide-react";
import type { RoomSummary } from "@/lib/types";
import { TOPIC_EMOJI, timeAgo } from "@/lib/utils";
import { Avatar } from "./Avatar";
import { unlockAudio } from "@/lib/audioUnlock";

export function RoomCard({ room, highlight }: { room: RoomSummary; highlight?: boolean }) {
  return (
    <Link
      href={`/room/${room.id}`}
      onClick={() => unlockAudio()} // join tap = user gesture → unlock room audio (iOS/Android WebView)
      className={
        "group block rounded-3xl border bg-zinc-900/70 p-5 shadow-lg transition hover:-translate-y-0.5 hover:bg-zinc-900 " +
        (highlight ? "border-emerald-500/30" : "border-white/5")
      }
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
        <span>
          {TOPIC_EMOJI[room.topic] ?? "✨"} {room.topic}
        </span>
        <span className="text-zinc-700">•</span>
        <span className="flex items-center gap-1 text-emerald-400/90">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live {timeAgo(room.createdAt)}
        </span>
      </div>
      <h3 className="mb-4 text-lg font-semibold leading-snug text-zinc-50 group-hover:text-white">{room.title}</h3>
      <div className="flex items-center gap-4">
        <div className="relative h-[66px] w-[66px] shrink-0">
          {room.speakers.slice(0, 2).map((s, i) => (
            <div
              key={s.id}
              className={room.speakers.length === 1 ? "absolute top-[13px] left-[13px]" : i === 0 ? "absolute top-0 left-0" : "absolute right-0 bottom-0 rounded-[40%] ring-[3px] ring-zinc-900"}
            >
              <Avatar name={s.name} color={s.color} photo={s.photoUrl} size="sm" />
            </div>
          ))}
          {room.speakers.length === 0 && <div className="flex h-14 w-14 items-center justify-center rounded-[38%] bg-zinc-800 text-xl">🎧</div>}
        </div>
        <div className="min-w-0 flex-1">
          <ul className="space-y-0.5 text-sm text-zinc-300">
            {room.speakers.slice(0, 3).map((s) => (
              <li key={s.id} className="flex items-center gap-1.5 truncate">
                <span className="truncate">{s.name}</span>
                {s.id === room.hostId && <span className="text-[10px] text-emerald-400">✳︎</span>}
                <MessageCircle className="h-3 w-3 shrink-0 text-zinc-600" />
              </li>
            ))}
          </ul>
          <div className="mt-1.5 flex items-center gap-3 text-xs text-zinc-500">
            <span className="flex items-center gap-1">
              {room.listenerCount + room.speakerCount} <User className="h-3 w-3" />
            </span>
            <span className="text-zinc-700">/</span>
            <span className="flex items-center gap-1">
              {room.speakerCount} <MessageCircle className="h-3 w-3" />
            </span>
            <span className="text-zinc-600">· {room.listenerCount} listening</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
