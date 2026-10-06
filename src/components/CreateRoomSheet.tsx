"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { TOPICS } from "@/lib/types";
import { TOPIC_EMOJI, cn } from "@/lib/utils";
import { Sheet } from "./Sheet";
import { useApp } from "./AppProvider";

/** Clubhouse-style default when the host skips the title field. */
function defaultTitle(topic: string) {
  return topic && topic !== "Other" ? `${topic} room` : "Open Lounge";
}

export function CreateRoomSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { request, toast, connected } = useApp();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState<string>("Tech");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function startRoom() {
    if (busy) return;
    setBusy(true);
    const payload = {
      title: title.trim() || defaultTitle(topic),
      topic,
      description,
    };
    try {
      // In-app room first — never wait on LiveKit. Audio connects after /room/[id] mounts.
      const res = await request<{ roomId: string }>("room:create", payload);
      const roomId = res.roomId;
      if (!roomId) throw new Error("Couldn't create the room");
      onClose();
      setTitle("");
      setDescription("");
      router.push(`/room/${roomId}`);
    } catch (err) {
      toast((err as Error).message || (connected ? "Couldn't start the room" : "Not connected — try again"));
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
        {/* Always highlighted — Clubhouse-style. Only spinner while the create request is in flight. */}
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent transition hover:bg-emerald-400 active:scale-[0.99] disabled:opacity-70"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} 🎉 Let&apos;s go
        </button>
      </form>
    </Sheet>
  );
}
