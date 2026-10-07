"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { TOPICS } from "@/lib/types";
import { TOPIC_EMOJI, cn } from "@/lib/utils";
import { Sheet } from "./Sheet";
import { useApp } from "./AppProvider";
import { unlockAudio } from "@/lib/audioUnlock";

/** Clubhouse-style default when the host skips the title field. */
function defaultTitle(topic: string) {
  return topic && topic !== "Other" ? `${topic} room` : "Open Lounge";
}

/** Wait until the realtime socket is up (or timeout). */
function waitFor(predicate: () => boolean, ms: number) {
  return new Promise<boolean>((resolve) => {
    if (predicate()) return resolve(true);
    const start = Date.now();
    const t = setInterval(() => {
      if (predicate()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start >= ms) {
        clearInterval(t);
        resolve(false);
      }
    }, 100);
  });
}

export function CreateRoomSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { request, toast, reportError, connected, socket } = useApp();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState<string>("Tech");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function startRoom() {
    if (busy) return;
    unlockAudio(); // Let's Go tap is a user gesture → unlock room audio before navigating
    setBusy(true);
    const payload = {
      title: title.trim() || defaultTitle(topic),
      topic,
      description,
    };
    try {
      // Never gate the tap on LiveKit/token/title. If the socket is briefly down, wait a beat.
      if (!socket?.connected) {
        const ok = await waitFor(() => !!socket?.connected, 5_000);
        if (!ok) throw new Error("Not connected — try again");
      }
      // In-app room first — audio connects after /room/[id] mounts and soft-fails if needed.
      const res = await request<{ roomId: string }>("room:create", payload);
      const roomId = res.roomId;
      if (!roomId) throw new Error("Couldn't create the room");
      onClose();
      setTitle("");
      setDescription("");
      router.push(`/room/${roomId}`);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  const go = () => void startRoom();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Start a room"
      footer={
        /* Clubhouse-style: ALWAYS emerald / tappable. Busy only shows a spinner — never greys out. */
        <button
          type="submit"
          form="create-room-form"
          data-letsgo-btn="1"
          aria-busy={busy}
          onClick={(e) => {
            // Extra path for WebViews that mishandle form submit.
            e.preventDefault();
            go();
          }}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-emerald-500 text-[17px] font-semibold text-on-accent shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400 active:scale-[0.98]"
        >
          {busy && <Loader2 className="h-5 w-5 animate-spin" />} 🎉 Let&apos;s go
        </button>
      }
    >
      <form
        id="create-room-form"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
        className="space-y-6"
        data-letsgo="always-on"
      >
        <label className="block">
          <span className="mb-2 flex items-baseline justify-between gap-2 text-sm font-medium text-zinc-300">
            <span>Title <span className="font-normal text-zinc-500">(optional)</span></span>
            <span className="text-xs tabular-nums text-zinc-500">{title.length}/80</span>
          </span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            enterKeyHint="next"
            autoCapitalize="sentences"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                document.getElementById("create-room-desc")?.focus();
              }
            }}
            placeholder="What do you want to talk about?"
            className="w-full min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-[16px] leading-6 text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-emerald-500/70 focus:bg-white/[0.06] focus:ring-4 focus:ring-emerald-500/15 h-[52px]"
          />
        </label>
        <div>
          <span className="mb-2 block text-sm font-medium text-zinc-300">Topic</span>
          <div className="flex flex-wrap gap-2">
            {TOPICS.map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTopic(t)}
                aria-pressed={topic === t}
                className={cn(
                  "min-h-10 rounded-full border px-3.5 py-2 text-sm transition active:scale-95",
                  topic === t
                    ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                    : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-200",
                )}
              >
                {TOPIC_EMOJI[t]} {t}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="mb-2 flex items-baseline justify-between gap-2 text-sm font-medium text-zinc-300">
            <span>Description <span className="font-normal text-zinc-500">(optional)</span></span>
            <span className="text-xs tabular-nums text-zinc-500">{description.length}/300</span>
          </span>
          <textarea
            id="create-room-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
            rows={3}
            enterKeyHint="go"
            autoCapitalize="sentences"
            placeholder="Set the vibe, share the agenda, house rules…"
            className="w-full min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-[16px] leading-6 text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-emerald-500/70 focus:bg-white/[0.06] focus:ring-4 focus:ring-emerald-500/15 block min-h-[104px] resize-none break-words py-3"
          />
        </label>
      </form>
    </Sheet>
  );
}
