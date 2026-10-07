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

  return (
    <Sheet open={open} onClose={onClose} title="Start a room">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void startRoom();
        }}
        className="space-y-5"
        data-letsgo="always-on"
      >
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-zinc-300">
            Title <span className="font-normal text-zinc-600">(optional)</span>
          </span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="What do you want to talk about?"
            className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
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
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm transition",
                  topic === t
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : "border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-200",
                )}
              >
                {TOPIC_EMOJI[t]} {t}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-zinc-300">
            Description <span className="text-zinc-600">(optional)</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
            rows={3}
            placeholder="Set the vibe, share the agenda, house rules…"
            className="w-full resize-none rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
          />
        </label>
        {/* Clubhouse-style: ALWAYS emerald / tappable. Busy only shows a spinner — never greys out. */}
        <button
          type="submit"
          data-letsgo-btn="1"
          aria-busy={busy}
          onClick={(e) => {
            // Extra path for WebViews that mishandle form submit.
            e.preventDefault();
            void startRoom();
          }}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400 active:scale-[0.99]"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} 🎉 Let&apos;s go
        </button>
      </form>
    </Sheet>
  );
}
