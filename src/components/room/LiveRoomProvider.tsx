"use client";

import { ReactionBar } from "@/components/room/ReactionBar";
import { useApp } from "@/components/AppProvider";
import { friendlyMessage, isTransient } from "@/lib/errors";
import { markAudio, useLiveKitAudio } from "@/hooks/useLiveKitAudio";
import { ROOM_CHAT_HISTORY, type ChatMessage, type RoomReaction, type RoomState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronUp, Radio, SmilePlus, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type Gone = { kind: "ended" | "kicked" | "error"; message: string } | null;
type PrefetchedAudio = { url: string; token: string } | null;
type AudioState = ReturnType<typeof useLiveKitAudio>;

interface LiveRoomContextValue {
  roomId: string | null;
  room: RoomState | null;
  chat: ChatMessage[];
  joined: boolean;
  gone: Gone;
  audio: AudioState;
  burstReactions: RoomReaction[];
  tileReactions: Record<string, RoomReaction[]>;
  reactionTrayOpen: boolean;
  activate(roomId: string): void;
  leave(): void;
  setReactionTrayOpen(open: boolean): void;
  sendReaction(emoji: string): Promise<void>;
  sendChat(text: string, replyToId?: string): Promise<boolean>;
  editChat(messageId: string, text: string): Promise<boolean>;
  deleteChat(messageId: string): Promise<void>;
  setSelfMuted(muted: boolean): void;
}

const LiveRoomContext = createContext<LiveRoomContextValue | null>(null);

const EMPTY_REACTIONS: Record<string, RoomReaction[]> = {};
const REACTION_TTL_MS = 1_600;
const BURST_TTL_MS = 1_800;

/**
 * Keeps one joined audio room alive above the route tree. Navigating between the hallway, messages,
 * profiles, and settings no longer unmounts the LiveKit connection or sends room:leave; only an
 * explicit leave (or a room end/kick) releases the seat and audio tracks.
 */
export function LiveRoomProvider({ children }: { children: React.ReactNode }) {
  const { socket, connected, me, request, reportError } = useApp();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [joined, setJoined] = useState(false);
  const [gone, setGone] = useState<Gone>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [prefetched, setPrefetched] = useState<PrefetchedAudio>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [burstReactions, setBurstReactions] = useState<RoomReaction[]>([]);
  const [tileReactions, setTileReactions] = useState<Record<string, RoomReaction[]>>(EMPTY_REACTIONS);
  const [reactionTrayOpen, setReactionTrayOpen] = useState(false);
  const joinedEpoch = useRef(-1);
  const reactionTimers = useRef(new Set<number>());

  // A reconnect has a new server-side room channel. Re-join it while preserving the still-connected
  // LiveKit audio room, exactly as the old room page did for a socket blip.
  useEffect(() => {
    if (connected) setConnectionEpoch((n) => n + 1);
  }, [connected]);

  useEffect(
    () => () => {
      reactionTimers.current.forEach((timer) => window.clearTimeout(timer));
      reactionTimers.current.clear();
    },
    [],
  );

  const clearSession = useCallback(() => {
    joinedEpoch.current = -1;
    setJoined(false);
    setRoomId(null);
    setRoom(null);
    setChat([]);
    setGone(null);
    setAudioEnabled(false);
    setPrefetched(null);
    setBurstReactions([]);
    setTileReactions(EMPTY_REACTIONS);
    setReactionTrayOpen(false);
  }, []);

  const activate = useCallback(
    (nextRoomId: string) => {
      if (!nextRoomId) return;
      setRoomId((current) => {
        if (current === nextRoomId) return current;
        // A user can hold one room seat at a time. Switching to another explicit room link cleanly
        // leaves the old seat; ordinary app navigation never reaches this path.
        if (current) socket?.emit("room:leave", { roomId: current });
        joinedEpoch.current = -1;
        setJoined(false);
        setRoom(null);
        setChat([]);
        setGone(null);
        setAudioEnabled(false);
        setPrefetched(null);
        setBurstReactions([]);
        setTileReactions(EMPTY_REACTIONS);
        setReactionTrayOpen(false);
        return nextRoomId;
      });
    },
    [socket],
  );

  // Join initially and re-join after a signaling reconnect. The LiveKit hook stays mounted above
  // routes, so its audio connection is not torn down while this request refreshes the app-level seat.
  useEffect(() => {
    if (!roomId || !socket || !connected || !me || gone) return;
    if (joined && joinedEpoch.current === connectionEpoch) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    markAudio("room-join-req");
    request<{ room: RoomState; chat?: ChatMessage[]; audio: { enabled: boolean; url?: string; token?: string } }>("room:join", { roomId })
      .then((res) => {
        if (cancelled) return;
        markAudio("room-joined");
        joinedEpoch.current = connectionEpoch;
        setRoom(res.room);
        setChat(res.chat ?? []);
        setAudioEnabled(!!res.audio?.enabled);
        setPrefetched(res.audio?.url && res.audio?.token ? { url: res.audio.url, token: res.audio.token } : null);
        setJoined(true);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        if (isTransient(error)) {
          retryTimer = setTimeout(() => setJoinAttempt((n) => n + 1), 2_000);
          return;
        }
        setJoined(false);
        setGone({ kind: /ended/i.test(error.message) ? "ended" : "error", message: friendlyMessage(error, "This room isn't available right now.") });
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [socket, connected, me, roomId, request, gone, joined, connectionEpoch, joinAttempt]);

  useEffect(() => {
    if (!socket) return;
    const onState = (state: RoomState) => state.id === roomId && setRoom(state);
    const onEnded = ({ roomId: endedRoomId }: { roomId: string }) => {
      if (endedRoomId !== roomId) return;
      setJoined(false);
      setGone({ kind: "ended", message: "The host ended this room." });
      setReactionTrayOpen(false);
    };
    const onKicked = ({ roomId: kickedRoomId, reason }: { roomId: string; reason: string }) => {
      if (kickedRoomId !== roomId) return;
      setJoined(false);
      setGone({ kind: "kicked", message: reason });
      setReactionTrayOpen(false);
    };
    const onChatMessage = (message: ChatMessage) => {
      if (message.roomId !== roomId) return;
      setChat((current) => (current.some((item) => item.id === message.id) ? current : [...current, message].slice(-ROOM_CHAT_HISTORY)));
    };
    const onChatDeleted = ({ roomId: deletedRoomId, messageId }: { roomId: string; messageId: string }) => {
      if (deletedRoomId === roomId) setChat((current) => current.filter((item) => item.id !== messageId));
    };
    const onChatEdited = (message: ChatMessage) => {
      if (message.roomId === roomId) setChat((current) => current.map((item) => (item.id === message.id ? { ...item, text: message.text, editedAt: message.editedAt } : item)));
    };
    const onReaction = (reaction: RoomReaction) => {
      if (reaction.roomId !== roomId) return;
      setBurstReactions((current) => [...current.slice(-12), reaction]);
      setTileReactions((current) => ({
        ...current,
        [reaction.userId]: [...(current[reaction.userId] ?? []).slice(-3), reaction],
      }));
      const tileTimer = window.setTimeout(() => {
        reactionTimers.current.delete(tileTimer);
        setTileReactions((current) => {
          const existing = current[reaction.userId] ?? [];
          const next = existing.filter((item) => item.id !== reaction.id);
          if (next.length === existing.length) return current;
          const copy = { ...current };
          if (next.length) copy[reaction.userId] = next;
          else delete copy[reaction.userId];
          return copy;
        });
      }, REACTION_TTL_MS);
      const burstTimer = window.setTimeout(() => {
        reactionTimers.current.delete(burstTimer);
        setBurstReactions((current) => current.filter((item) => item.id !== reaction.id));
      }, BURST_TTL_MS);
      reactionTimers.current.add(tileTimer);
      reactionTimers.current.add(burstTimer);
    };
    socket.on("room:state", onState);
    socket.on("room:ended", onEnded);
    socket.on("room:kicked", onKicked);
    socket.on("room:reaction", onReaction);
    socket.on("chat:message", onChatMessage);
    socket.on("chat:deleted", onChatDeleted);
    socket.on("chat:edited", onChatEdited);
    return () => {
      socket.off("room:state", onState);
      socket.off("room:ended", onEnded);
      socket.off("room:kicked", onKicked);
      socket.off("room:reaction", onReaction);
      socket.off("chat:message", onChatMessage);
      socket.off("chat:deleted", onChatDeleted);
      socket.off("chat:edited", onChatEdited);
    };
  }, [socket, roomId]);

  const meParticipant = room?.participants.find((participant) => participant.userId === me?.id) ?? null;
  const audio = useLiveKitAudio({
    roomId: roomId ?? "",
    enabled: audioEnabled,
    prefetched,
    joined: joined && !!meParticipant,
    isSpeaker: !!meParticipant && meParticipant.role !== "listener",
    muted: meParticipant?.muted ?? true,
  });

  const leave = useCallback(() => {
    if (roomId) socket?.emit("room:leave", { roomId });
    clearSession();
  }, [socket, roomId, clearSession]);

  const sendReaction = useCallback(
    async (emoji: string) => {
      if (!roomId) return;
      try {
        await request("reaction:send", { roomId, emoji });
      } catch (error) {
        reportError(error);
      }
    },
    [request, reportError, roomId],
  );

  const sendChat = useCallback(
    async (text: string, replyToId?: string) => {
      if (!roomId) return false;
      try {
        await request("chat:send", { roomId, text, replyToId });
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [request, reportError, roomId],
  );

  const editChat = useCallback(
    async (messageId: string, text: string) => {
      if (!roomId) return false;
      try {
        const response = await request<{ message?: ChatMessage }>("chat:edit", { roomId, messageId, text });
        const message = response?.message;
        if (message) setChat((current) => current.map((item) => (item.id === message.id ? { ...item, text: message.text, editedAt: message.editedAt } : item)));
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [request, reportError, roomId],
  );

  const deleteChat = useCallback(
    async (messageId: string) => {
      if (!roomId) return;
      try {
        await request("chat:delete", { roomId, messageId });
      } catch (error) {
        reportError(error);
      }
    },
    [request, reportError, roomId],
  );

  const setSelfMuted = useCallback(
    (muted: boolean) => {
      if (!roomId || !me?.id) return;
      setRoom((current) =>
        current
          ? { ...current, participants: current.participants.map((participant) => (participant.userId === me.id ? { ...participant, muted, speaking: false } : participant)) }
          : current,
      );
      socket?.emit("self:mute", { roomId, muted });
    },
    [socket, roomId, me?.id],
  );

  const value = useMemo<LiveRoomContextValue>(
    () => ({ roomId, room, chat, joined, gone, audio, burstReactions, tileReactions, reactionTrayOpen, activate, leave, setReactionTrayOpen, sendReaction, sendChat, editChat, deleteChat, setSelfMuted }),
    [roomId, room, chat, joined, gone, audio, burstReactions, tileReactions, reactionTrayOpen, activate, leave, sendReaction, sendChat, editChat, deleteChat, setSelfMuted],
  );

  return (
    <LiveRoomContext.Provider value={value}>
      {children}
      <LiveRoomMiniBar />
    </LiveRoomContext.Provider>
  );
}

export function useLiveRoom() {
  const context = useContext(LiveRoomContext);
  if (!context) throw new Error("useLiveRoom must be used inside LiveRoomProvider");
  return context;
}

export const TRAY_IDLE_MS = 5000;

function LiveRoomMiniBar() {
  const { roomId, room, joined, gone, audio, leave, sendReaction, reactionTrayOpen, setReactionTrayOpen } = useLiveRoom();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const barRef = useRef<HTMLDivElement>(null);
  const visible = !!roomId && !!room && joined && !gone && pathname !== `/room/${roomId}`;

  // Auto-tuck: after TRAY_IDLE_MS with no interaction the bar collapses into a small edge tab
  // (the tab is still measured/reserved, so it never covers UI). Never tucks while the reaction
  // tray is open, audio is not connected, or audio needs a tap to start. Tapping the tab reopens it.
  const [tucked, setTucked] = useState(false);
  const [poke, setPoke] = useState(0);
  const holdOpen = reactionTrayOpen || audio.status !== "connected" || !!audio.needsGesture;
  const interact = useCallback(() => setPoke((n) => n + 1), []);
  useEffect(() => {
    if (!visible) { setTucked(false); return; }
    if (tucked || holdOpen) return;
    const t = window.setTimeout(() => setTucked(true), TRAY_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [visible, tucked, holdOpen, poke, pathname]);
  useEffect(() => { if (holdOpen) setTucked(false); }, [holdOpen]);

  // Publish the bar's real height as --ol-liveroom-bar-h and pin it to the visual viewport
  // (above the on-screen keyboard). Pages reserve that space via globals.css so the tray
  // never covers composers, docks, sheets, or other controls.
  useEffect(() => {
    const root = document.documentElement;
    if (!visible) {
      root.removeAttribute("data-live-room-bar");
      root.style.removeProperty("--ol-liveroom-bar-h");
      return;
    }
    root.setAttribute("data-live-room-bar", "");
    const el = barRef.current;
    if (!el) {
      return () => {
        root.removeAttribute("data-live-room-bar");
        root.style.removeProperty("--ol-liveroom-bar-h");
      };
    }
    const sync = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      root.style.setProperty("--ol-liveroom-bar-h", `${height}px`);
      const vv = window.visualViewport;
      // Distance from the layout viewport bottom to the visual viewport bottom (= keyboard cover).
      const keyboard = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      el.style.bottom = `${keyboard}px`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", sync, { passive: true });
    vv?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync, { passive: true });
    return () => {
      ro.disconnect();
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      root.removeAttribute("data-live-room-bar");
      root.style.removeProperty("--ol-liveroom-bar-h");
    };
  }, [visible, reactionTrayOpen, tucked]);

  if (!visible || !room || !roomId) return null;
  return (
    <div
      ref={barRef}
      className="fixed inset-x-0 bottom-0 z-[70] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4"
      data-testid="live-room-bar"
      data-tucked={tucked ? "" : undefined}
      onPointerDown={interact}
      onKeyDown={interact}
      onFocus={interact}
    >
      {tucked ? (
        <div className="mx-auto flex max-w-2xl justify-end">
          <button
            type="button"
            onClick={() => { setTucked(false); interact(); }}
            aria-label={`Show live room tray: ${room.title}`}
            data-testid="live-room-tab"
            className="ol-tray-tab flex h-8 items-center gap-1.5 rounded-full border border-emerald-400/30 bg-zinc-950/95 pl-2 pr-3 text-xs font-semibold text-emerald-300 shadow-xl backdrop-blur-xl"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live
          </button>
        </div>
      ) : (
      <div className="ol-tray-open mx-auto max-w-2xl">
        <ReactionBar open={reactionTrayOpen} onPick={sendReaction} />
        <div className="flex min-w-0 items-center gap-2 rounded-2xl border border-emerald-400/30 bg-zinc-950/95 p-2 shadow-2xl backdrop-blur-xl">
          <button
            type="button"
            onClick={() => router.push(`/room/${roomId}`)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-white/5"
            aria-label={`Return to ${room.title}`}
          >
            <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-300">
              <Radio className="h-4 w-4" />
              <span className="live-dot absolute right-1.5 bottom-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-zinc-100">{room.title}</span>
              <span className="block truncate text-xs text-zinc-400">{audio.status === "connected" ? "Live audio continues" : audio.status === "reconnecting" ? "Reconnecting audio…" : "Live room"}</span>
            </span>
            <ChevronUp className="h-4 w-4 shrink-0 text-zinc-400" />
          </button>
          <button
            type="button"
            onClick={() => setReactionTrayOpen(!reactionTrayOpen)}
            aria-label="Send a room reaction"
            aria-pressed={reactionTrayOpen}
            className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl transition", reactionTrayOpen ? "bg-sky-500 text-white" : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700")}
          >
            <SmilePlus className="h-5 w-5" />
          </button>
          <button type="button" onClick={leave} aria-label="Leave live room" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-zinc-800 text-zinc-300 hover:bg-red-500/20 hover:text-red-300">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
