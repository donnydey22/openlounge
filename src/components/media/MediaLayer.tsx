"use client";
// Per-thread media plumbing, mounted once by DmThread: live "media:update" events (processed, played, opened,
// expired, deleted), reconnect reconciliation (offline clients learn what expired and never fetch it), and the
// full-screen viewers.
import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { DirectMessage, PublicUser } from "@/lib/types";
import type { MediaUpdateEvent } from "@/lib/media/types";
import { dropUrls, reconcileMedia } from "@/lib/media/client";
import { useViewer } from "./viewerStore";

const MediaViewer = dynamic(() => import("./MediaViewer").then((m) => m.MediaViewer), { ssr: false });
const PdfViewer = dynamic(() => import("./PdfViewer").then((m) => m.PdfViewer), { ssr: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sock = { on(ev: string, fn: (d: any) => void): void; off(ev: string, fn: (d: any) => void): void } | null;

export function applyMediaUpdate<T extends DirectMessage>(list: T[] | null, ev: MediaUpdateEvent): T[] | null {
  if (!list) return list;
  const i = list.findIndex((m) => m.id === ev.messageId);
  if (i < 0) return list;
  const next = [...list];
  const prev = next[i];
  // the event carries the full state: albums send `attachments`; no `attachments` → not (or no longer) an album
  const { attachments: _drop, ...rest } = prev; // eslint-disable-line @typescript-eslint/no-unused-vars
  next[i] = { ...rest, media: ev.media, ...(ev.attachments?.length ? { attachments: ev.attachments } : {}), ...(ev.text !== undefined ? { text: ev.text } : {}) } as T;
  if (ev.media.gone) dropUrls(ev.media.id);
  const keep = new Set((ev.attachments ?? [ev.media]).map((x) => x.id));
  for (const x of prev.attachments ?? []) if (!keep.has(x.id)) dropUrls(x.id);
  return next;
}

export function MediaLayer<T extends DirectMessage>({
  socket,
  connected,
  messages,
  setMessages,
  me,
  peer,
}: {
  socket: Sock;
  connected: boolean;
  messages: T[] | null;
  setMessages: (fn: (list: T[] | null) => T[] | null) => void;
  me: { id: string } | null;
  peer: PublicUser | null;
}) {
  const viewer = useViewer();
  const msgsRef = useRef(messages);
  msgsRef.current = messages;

  useEffect(() => {
    if (!socket) return;
    const onUpdate = (ev: MediaUpdateEvent) => setMessages((list) => applyMediaUpdate(list, ev));
    socket.on("media:update", onUpdate);
    return () => socket.off("media:update", onUpdate);
  }, [socket, setMessages]);

  // reconnect: anything that expired / was deleted / finished processing while we were away
  const wasConnected = useRef(connected);
  useEffect(() => {
    const was = wasConnected.current;
    wasConnected.current = connected;
    if (!connected || was) return;
    const ids = (msgsRef.current ?? []).filter((m) => m.media && !m.media.gone && !m.id.startsWith("local-")).map((m) => m.id);
    if (!ids.length) return;
    void reconcileMedia(ids)
      .then((r) => setMessages((list) => r.items.reduce((acc, ev) => applyMediaUpdate(acc, ev), list)))
      .catch(() => {});
  }, [connected, setMessages]);

  if (!viewer) return null;
  if (viewer.mode === "pdf") return <PdfViewer target={viewer} />;
  return <MediaViewer target={viewer} messages={(messages ?? []) as DirectMessage[]} me={me} peer={peer} />;
}
