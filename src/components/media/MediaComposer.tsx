"use client";
// Composer side of attachments for a chat thread: 📎 button + preview sheet, paste / drag-and-drop of files, and the
// voice note button. Everything ends in queueMedia() (optimistic bubble + resumable upload + send).
import { useCallback, useEffect, useState } from "react";
import type { DirectMessage } from "@/lib/types";
import { serverNow } from "@/lib/time";
import { kindForFile, queueAlbum, queueMedia, type QueueCallbacks } from "@/lib/media/outbox";
import { ALBUM_MAX } from "@/lib/media/types";
import { AttachButton, AttachPreview, type AttachSend, type PickSource } from "./AttachSheet";
import { VoiceRecordButton, type Recorded } from "./VoiceRecorder";

export interface MediaSendCtx {
  peerId: string;
  peerName?: string;
  me: { id: string; name: string; color: string } | null;
  newClientId: () => string;
  /** add the optimistic message to the thread (and scroll to it) */
  onQueued: (m: DirectMessage & { state: "sending" }) => void;
  callbacks: QueueCallbacks;
}

export function useMediaSend(ctx: MediaSendCtx) {
  const { peerId, me, newClientId, onQueued, callbacks } = ctx;
  const sendFiles = useCallback(
    async (s: AttachSend) => {
      if (!me) return;
      const base = { peerId, me, ttlSeconds: s.ttlSeconds, now: serverNow(), newClientId };
      if (s.album && !s.asFile && s.files.length > 1) {
        // albums of up to 10, in the tray's order; the caption rides on the first one
        for (let i = 0; i < s.files.length; i += ALBUM_MAX) {
          const chunk = s.files.slice(i, i + ALBUM_MAX);
          const caption = i === 0 ? s.caption : "";
          onQueued(chunk.length > 1 ? await queueAlbum(chunk, { ...base, caption }, callbacks) : await queueMedia(chunk[0], kindForFile(chunk[0]), { ...base, caption }, callbacks));
        }
        return;
      }
      // one at a time so bubbles keep the picked order
      for (const [i, f] of s.files.entries()) {
        const item = await queueMedia(f, kindForFile(f, s.asFile), { ...base, caption: i === s.files.length - 1 ? s.caption : "", viewOnce: s.viewOnce }, callbacks);
        onQueued(item);
      }
    },
    [peerId, me, newClientId, onQueued, callbacks],
  );
  const sendVoice = useCallback(
    async (r: Recorded) => {
      if (!me) return;
      const item = await queueMedia(r.blob, "voice", { peerId, me, voice: { durMs: r.durMs, wave: r.wave }, now: serverNow(), newClientId }, callbacks);
      onQueued(item);
    },
    [peerId, me, newClientId, onQueued, callbacks],
  );
  return { sendFiles, sendVoice };
}

/** 📎 + preview sheet; also opens the sheet for pasted / dropped files. */
export function MediaAttach({ ctx, disabled, pasted, onPastedConsumed }: { ctx: MediaSendCtx; disabled?: boolean; pasted?: File[] | null; onPastedConsumed?: () => void }) {
  const { sendFiles } = useMediaSend(ctx);
  const [picked, setPicked] = useState<{ files: File[]; asFile: boolean; source: PickSource } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (pasted?.length) {
      setPicked({ files: pasted, asFile: false, source: "paste" });
      onPastedConsumed?.();
    }
  }, [pasted, onPastedConsumed]);

  // drag a file anywhere onto the open thread
  useEffect(() => {
    if (disabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) setPicked({ files, asFile: false, source: "paste" });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [disabled]);

  return (
    <>
      <AttachButton disabled={disabled} onPick={(files, asFile, source) => setPicked({ files, asFile, source })} />
      {picked && (
        <AttachPreview
          files={picked.files}
          asFile={picked.asFile}
          source={picked.source}
          peerName={ctx.peerName}
          onClose={() => setPicked(null)}
          onSend={(s) => {
            setPicked(null);
            void sendFiles(s);
          }}
        />
      )}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
          <div className="rounded-3xl border-2 border-dashed border-emerald-400 px-10 py-8 text-center text-lg font-semibold text-emerald-300">Drop to send</div>
        </div>
      )}
    </>
  );
}

export function MediaVoiceButton({ ctx, disabled }: { ctx: MediaSendCtx; disabled?: boolean }) {
  const { sendVoice } = useMediaSend(ctx);
  return <VoiceRecordButton disabled={disabled} onRecorded={(r) => void sendVoice(r)} />;
}
