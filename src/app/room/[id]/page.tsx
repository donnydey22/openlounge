"use client";

import { RoomBranding } from "@/components/creator/RoomBranding";
import { friendlyMessage, isTransient } from "@/lib/errors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChevronDown, Flag, Hand, Link2, Loader2, Lock, MessageSquare, Mic, MicOff, MoreHorizontal, Power, SmilePlus, UserPlus, Volume2 } from "lucide-react";
import { ROOM_CHAT_HISTORY, type ChatMessage, type Participant, type RoomPresenceEvent, type RoomReaction, type RoomState } from "@/lib/types";
import { TOPIC_EMOJI, cn, timeAgo } from "@/lib/utils";
import { formatFull, serverNow, useClockTick } from "@/lib/time";
import { useApp } from "@/components/AppProvider";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/components/Sheet";
import { ParticipantTile } from "@/components/room/ParticipantTile";
import { UserActionSheet } from "@/components/room/UserActionSheet";
import { useLiveKitAudio } from "@/hooks/useLiveKitAudio";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { unlockAudio } from "@/lib/audioUnlock";
import { RoomChatPanel } from "@/components/chat/RoomChatPanel";
import { ReportSheet } from "@/components/safety/ReportSheet";
import { BlockConfirm } from "@/components/safety/BlockConfirm";
import { useSafety, type ReportTarget } from "@/lib/safety";
import { DmThread } from "@/components/chat/DmThread";
import { RoomEventFeed } from "@/components/room/RoomEventFeed";
import { ReactionBar } from "@/components/room/ReactionBar";
import { ReactionBurst } from "@/components/room/ReactionBurst";
import { useNotifier } from "@/components/Notifier";
import { OPEN_DM_EVENT } from "@/lib/notify";
import { InviteToRoomSheet } from "@/components/rooms/InviteToRoomSheet";
import { DropInStatus } from "@/components/rooms/DropInStatus";
import { markAudio } from "@/hooks/useLiveKitAudio";
import { useScrollLock } from "@/lib/scrollLock";
import { LinkifiedText } from "@/components/chat/LinkifiedText";

type Gone = { kind: "ended" | "kicked" | "error"; message: string } | null;

export default function RoomPage() {
  const { id: roomId } = useParams<{ id: string }>();
  useClockTick(); // "Live · 12m" / "raised 2m ago" keep counting
  const router = useRouter();
  const { socket, connected, me, request, following, toast, reportError } = useApp();
  const [joinAttempt, setJoinAttempt] = useState(0);

  const [room, setRoom] = useState<RoomState | null>(null);
  const [joined, setJoined] = useState(false);
  const [gone, setGone] = useState<Gone>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [handsOpen, setHandsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const safety = useSafety(me?.id);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [blockTarget, setBlockTarget] = useState<{ id: string; name: string } | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [lkPrefetched, setLkPrefetched] = useState<{ url: string; token: string } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [showDesc, setShowDesc] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [preview, setPreview] = useState<ChatMessage | null>(null);
  const [dmPeer, setDmPeer] = useState<string | null>(null);
  const [presenceFeed, setPresenceFeed] = useState<RoomPresenceEvent[]>([]);
  const [burstReactions, setBurstReactions] = useState<RoomReaction[]>([]);
  const [tileReactions, setTileReactions] = useState<Record<string, string>>({});
  const [reactOpen, setReactOpen] = useState(false);
  const leftRef = useRef(false);
  const notifier = useNotifier();

  // join / re-join on (re)connect
  useEffect(() => {
    if (!socket || !connected || !me || gone) return;
    leftRef.current = false;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    markAudio("room-join-req");
    request<{ room: RoomState; chat: ChatMessage[]; audio: { enabled: boolean; url?: string; token?: string } }>("room:join", { roomId })
      .then((res) => {
        if (cancelled) return;
        markAudio("room-joined");
        setRoom(res.room);
        setChat(res.chat ?? []);
        if (res.audio?.url && res.audio?.token) setLkPrefetched({ url: res.audio.url, token: res.audio.token });
        setAudioEnabled(!!res.audio?.enabled);
        setJoined(true);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // connection trouble: try again quietly (a reconnect also re-runs this effect)
        if (isTransient(e)) {
          retryTimer = setTimeout(() => setJoinAttempt((n) => n + 1), 2_000);
          return;
        }
        setGone({ kind: /ended/i.test(e.message) ? "ended" : "error", message: friendlyMessage(e, "This room isn't available right now.") });
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [socket, connected, me, roomId, request, gone, joinAttempt]);

  // NOTE: a WebSocket blip no longer tears down LiveKit audio (we used to set joined=false here).
  // The join effect above re-joins the room as soon as the socket is back, so the app-level
  // seat matches the still-running LiveKit connection.

  // live updates
  useEffect(() => {
    if (!socket) return;
    const onState = (s: RoomState) => s.id === roomId && setRoom(s);
    const onEnded = ({ roomId: rid }: { roomId: string }) => {
      if (rid !== roomId) return;
      setJoined(false);
      setGone({ kind: "ended", message: "The host ended this room." });
    };
    const onKicked = ({ roomId: rid, reason }: { roomId: string; reason: string }) => {
      if (rid !== roomId) return;
      setJoined(false);
      setGone({ kind: "kicked", message: reason });
    };
    const onPresence = (ev: RoomPresenceEvent) => {
      if (ev.roomId !== roomId) return;
      // skip own join toast noise
      if (ev.type === "join" && ev.userId === me?.id) return;
      setPresenceFeed((f) => [...f.slice(-4), ev]);
    };
    const onReaction = (r: RoomReaction) => {
      if (r.roomId !== roomId) return;
      setBurstReactions((b) => [...b.slice(-12), r]);
      setTileReactions((m) => ({ ...m, [r.userId]: r.emoji }));
      window.setTimeout(() => {
        setTileReactions((m) => {
          if (m[r.userId] !== r.emoji) return m;
          const next = { ...m };
          delete next[r.userId];
          return next;
        });
      }, 1600);
      window.setTimeout(() => {
        setBurstReactions((b) => b.filter((x) => x.id !== r.id));
      }, 1800);
    };
    socket.on("room:state", onState);
    socket.on("room:ended", onEnded);
    socket.on("room:kicked", onKicked);
    socket.on("room:presence", onPresence);
    socket.on("room:reaction", onReaction);
    return () => {
      socket.off("room:state", onState);
      socket.off("room:ended", onEnded);
      socket.off("room:kicked", onKicked);
      socket.off("room:presence", onPresence);
      socket.off("room:reaction", onReaction);
    };
  }, [socket, roomId, me?.id]);

  // auto-dismiss presence toasts
  useEffect(() => {
    if (presenceFeed.length === 0) return;
    const t = setTimeout(() => setPresenceFeed((f) => f.slice(1)), 2800);
    return () => clearTimeout(t);
  }, [presenceFeed]);

  // leave when navigating away
  useEffect(() => {
    return () => {
      if (!leftRef.current) socket?.emit("room:leave", { roomId });
    };
  }, [socket, roomId]);

  const participants = room?.participants ?? [];
  const meP = participants.find((p) => p.userId === me?.id);
  const amHost = !!meP && room?.hostId === me?.id;

  const audio = useLiveKitAudio({
    roomId,
    enabled: audioEnabled,
    prefetched: lkPrefetched,
    joined: joined && !!meP,
    isSpeaker: !!meP && meP.role !== "listener",
    muted: meP?.muted ?? true,
  });
  const localLevel = audio.localLevel;
  // humans: LiveKit active-speaker detection + levels; demo bots: simulated by the server
  const isSpeaking = (p: Participant) => {
    if (p.muted) return false; // glow always off while muted
    if (p.isBot) return p.speaking;
    const lvl = audio.levels.get(p.userId) ?? 0;
    return audio.speaking.has(p.userId) || lvl > 0.04;
  };
  const audioLevelOf = (p: Participant) => {
    if (p.muted) return 0;
    if (p.isBot) return p.speaking ? 0.55 : 0;
    if (p.userId === me?.id) return localLevel;
    return audio.levels.get(p.userId) ?? (isSpeaking(p) ? 0.35 : 0);
  };
  const podiumId = room?.podiumUserId ?? null;

  // ----- notifications: tell the notifier which room we're in + who's talking -----
  useEffect(() => {
    if (joined && room && me?.id && room.id === roomId) notifier.setRoomContext({ room, meId: me.id });
  }, [notifier, joined, room, me?.id, roomId]);
  useEffect(() => () => notifier.setRoomContext(null), [notifier, roomId]);
  const speakingKey = [...audio.speaking].sort().join(",");
  useEffect(() => {
    notifier.reportSpeaking(roomId, speakingKey ? speakingKey.split(",") : []);
  }, [notifier, roomId, speakingKey]);

  // a DM notification/banner tapped while in the room opens the DM drawer (navigating away would leave the room)
  useEffect(() => {
    const onOpenDm = (e: Event) => {
      const peerId = (e as CustomEvent<{ peerId?: string }>).detail?.peerId;
      if (peerId) setDmPeer(peerId);
    };
    window.addEventListener(OPEN_DM_EVENT, onOpenDm);
    return () => window.removeEventListener(OPEN_DM_EVENT, onOpenDm);
  }, []);

  const { stage, audience, hands } = useMemo(() => {
    const stage = participants
      .filter((p) => p.role !== "listener")
      .sort((a, b) => (a.role === "host" ? -1 : b.role === "host" ? 1 : a.joinedAt - b.joinedAt));
    const listeners = participants.filter((p) => p.role === "listener");
    // Clubhouse-style: people you follow (and raised hands) float up in the audience
    const score = (p: Participant) => (p.userId === me?.id ? 0 : p.handRaised ? 1 : following.has(p.userId) ? 2 : p.isBot ? 4 : 3);
    const audience = [...listeners].sort((a, b) => score(a) - score(b) || a.joinedAt - b.joinedAt);
    const hands = listeners.filter((p) => p.handRaised).sort((a, b) => (a.handRaisedAt ?? 0) - (b.handRaisedAt ?? 0));
    return { stage, audience, hands };
  }, [participants, following, me?.id]);

  const leave = () => {
    leftRef.current = true;
    socket?.emit("room:leave", { roomId });
    router.push("/");
  };

  const toggleMute = () => {
    if (!meP || meP.role === "listener") return;
    unlockAudio(); // user gesture: also unlocks playback (iOS / Android WebView autoplay)
    const nextMuted = !meP.muted;
    if (!nextMuted && audio.status === "unavailable") toast("🔇 Live audio is off on this server — others see you as unmuted, but no sound is sent.");
    // optimistic: flip the local mic + icon now; the server broadcasts room:state to everyone
    setRoom((r) => (r ? { ...r, participants: r.participants.map((p) => (p.userId === meP.userId ? { ...p, muted: nextMuted, speaking: false } : p)) } : r));
    socket?.emit("self:mute", { roomId, muted: nextMuted });
  };

  const toggleHand = () => {
    if (!meP) return;
    socket?.emit("hand:set", { roomId, raised: !meP.handRaised });
    if (!meP.handRaised) toast(amHost ? "✋ Hand raised" : "✋ Hand raised — the host will see you're in the queue");
  };

  const invite = async (userId: string) => {
    try {
      await request("host:invite", { roomId, userId });
    } catch (e) {
      reportError(e);
    }
  };

  const sendReaction = async (emoji: string) => {
    try {
      await request("reaction:send", { roomId, emoji });
    } catch (e) {
      reportError(e);
    }
  };

  const claimPodium = async () => {
    if (!me?.id) return;
    try {
      await request("podium:set", { roomId, userId: me.id });
    } catch (e) {
      reportError(e);
    }
  };


  const endRoom = async () => {
    try {
      leftRef.current = true;
      await request("room:end", { roomId });
      router.push("/");
    } catch (e) {
      reportError(e);
    }
  };


  // ----- room chat -----
  // Desktop shows chat as a side panel; mobile opens it as a drawer.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const chatVisible = isDesktop || chatOpen;
  useScrollLock((chatOpen && !isDesktop) || !!dmPeer); // drawers pin the stage behind them
  const chatVisibleRef = useRef(chatVisible);
  chatVisibleRef.current = chatVisible;
  const meId = me?.id;

  useEffect(() => {
    if (chatVisible) {
      setChatUnread(0);
      setPreview(null);
    }
  }, [chatVisible]);

  useEffect(() => {
    if (!socket) return;
    const onMessage = (m: ChatMessage) => {
      if (m.roomId !== roomId) return;
      setChat((c) => (c.some((x) => x.id === m.id) ? c : [...c, m].slice(-ROOM_CHAT_HISTORY)));
      if (!chatVisibleRef.current && m.authorId !== meId) {
        setChatUnread((n) => n + 1);
        setPreview(m);
      }
    };
    const onDeleted = ({ roomId: rid, messageId }: { roomId: string; messageId: string }) => {
      if (rid === roomId) setChat((c) => c.filter((x) => x.id !== messageId));
    };
    socket.on("chat:message", onMessage);
    socket.on("chat:deleted", onDeleted);
    return () => {
      socket.off("chat:message", onMessage);
      socket.off("chat:deleted", onDeleted);
    };
  }, [socket, roomId, meId]);

  useEffect(() => {
    if (!preview) return;
    const t = setTimeout(() => setPreview(null), 5000);
    return () => clearTimeout(t);
  }, [preview]);

  const sendChat = useCallback(
    async (text: string) => {
      try {
        await request("chat:send", { roomId, text });
        return true;
      } catch (e) {
        reportError(e);
        return false;
      }
    },
    [request, roomId, toast],
  );

  const deleteChat = useCallback(
    async (messageId: string) => {
      try {
        await request("chat:delete", { roomId, messageId });
      } catch (e) {
        reportError(e);
      }
    },
    [request, roomId, toast],
  );

  if (gone) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-5xl">{gone.kind === "ended" ? "👋" : gone.kind === "kicked" ? "🔀" : "🤔"}</div>
        <h1 className="text-xl font-semibold">{gone.kind === "ended" ? "This room has ended" : gone.kind === "kicked" ? "You left this room" : "Can't join room"}</h1>
        <p className="text-zinc-400">{gone.message}</p>
        <Link href="/" className="mt-2 rounded-full bg-emerald-500 px-6 py-3 font-semibold text-on-accent hover:bg-emerald-400">
          Back to the hallway
        </Link>
      </main>
    );
  }

  if (!room || !meP) {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-2 text-zinc-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Joining room…
      </div>
    );
  }

  const selectedP = participants.find((p) => p.userId === selected) ?? null;
  const openAuthor = (userId: string) => {
    if (participants.some((p) => p.userId === userId)) setSelected(userId);
    else router.push(`/profile/${userId}`);
  };
  const onStage = meP.role !== "listener";

  return (
    <div className="mx-auto max-w-2xl lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6 lg:px-4">
     <div className="flex min-h-dvh min-w-0 flex-col">
      {/* header */}
      <header data-app-header className="sticky top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)] items-center justify-between bg-app/80 px-3 backdrop-blur-xl">
        <button onClick={() => router.push("/")} className="flex items-center gap-1 rounded-full px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-white/5" title="Back to hallway (leaves the room)">
          <ChevronDown className="h-5 w-5" /> Hallway
        </button>
        <div className="flex items-center gap-1">
          {!connected && <span className="mr-2 text-xs text-amber-400 animate-pulse">Reconnecting…</span>}
          <button onClick={() => setInviteOpen(true)} className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-emerald-400 hover:bg-white/5" aria-label="Invite people" data-testid="room-invite">
            <UserPlus className="h-5 w-5" /> <span className="hidden min-[380px]:inline">Invite</span>
          </button>
          <button onClick={() => setMenuOpen(true)} className="rounded-full p-2.5 text-zinc-300 hover:bg-white/5" aria-label="Room menu">
            <MoreHorizontal className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* room body */}
      <main className="relative flex-1 px-3 pb-4" data-audio-status={audio.status}>
        {/* hosts & speakers get joins as a batched notification banner instead ("Alex and 3 others joined") */}
        <RoomEventFeed events={onStage ? presenceFeed.filter((e) => e.type !== "join") : presenceFeed} />
        <div className="relative rounded-[2rem] border border-white/5 bg-zinc-900/70 px-5 pt-6 pb-8 shadow-2xl" style={{ marginTop: "calc(var(--ol-banner-h) + var(--ol-banner-gap))" }}>
          <ReactionBurst reactions={burstReactions} />
          <RoomBranding hostId={room.hostId} />
          <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <span>
              {TOPIC_EMOJI[room.topic] ?? "✨"} {room.topic}
            </span>
            <span className="text-zinc-700">•</span>
            <span className="flex items-center gap-1 text-emerald-400/90">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" /> <span title={`Started ${formatFull(room.createdAt)}`}>Live · {timeAgo(room.createdAt)}</span>
            </span>
          </div>
          <h1 className="text-xl font-bold leading-snug [overflow-wrap:anywhere]">
            <LinkifiedText text={room.title} />
          </h1>
          {room.private && (
            <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500" data-testid="room-private">
              <Lock className="h-3 w-3" /> {room.dropin ? "Private drop-in audio chat" : "Invite only"}
            </div>
          )}
          {room.dropin && <DropInStatus room={room} meId={me?.id} audio={audio.status} />}
          {room.description && (
            <button onClick={() => setShowDesc((v) => !v)} className={cn("mt-2 block w-full max-w-full text-left text-sm text-zinc-400 [overflow-wrap:anywhere]", !showDesc && "line-clamp-2")}>
              <LinkifiedText text={room.description} links={false} />
            </button>
          )}

          <AudioStatusPill status={audio.status} error={audio.error} />

          {/* podium strip */}
          {(() => {
            const holder = podiumId ? participants.find((x) => x.userId === podiumId) : null;
            return (
              <div className="mt-4 flex items-center gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/5 px-3 py-2">
                <span className="text-sm">🎙</span>
                <div className="min-w-0 flex-1 text-xs">
                  <div className="podium-label font-semibold text-amber-300">Podium</div>
                  <div className="truncate text-zinc-400">
                    {holder ? (
                      <>
                        <span className="text-zinc-200">{holder.userId === me?.id ? "You" : holder.name}</span> {holder.userId === me?.id ? "hold" : "holds"} speaking priority
                      </>
                    ) : (
                      "No one on the podium — unmute or claim it from stage"
                    )}
                  </div>
                </div>
                {onStage && podiumId !== me?.id && (
                  <button
                    onClick={claimPodium}
                    className="shrink-0 rounded-full bg-amber-400/20 px-3 py-1.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-400/30"
                  >
                    Claim
                  </button>
                )}
              </div>
            );
          })()}

          {/* stage */}
          <section className="mt-6">
            <h2 className="mb-3 text-sm font-semibold text-zinc-400">
              On stage <span className="font-normal text-zinc-600">· {stage.length}</span>
            </h2>
            <div className="grid grid-cols-3 gap-x-2 gap-y-5 sm:grid-cols-4">
              {stage.map((p) => (
                <ParticipantTile
                  key={p.userId}
                  p={{ ...p, speaking: isSpeaking(p) }}
                  size="lg"
                  isHost={p.userId === room.hostId}
                  isMe={p.userId === me?.id}
                  followed={following.has(p.userId)}
                  level={audioLevelOf(p)}
                  onPodium={p.userId === podiumId}
                  floatingEmoji={tileReactions[p.userId] ?? null}
                  onClick={() => setSelected(p.userId)}
                  onToggleMute={p.userId === me?.id ? toggleMute : undefined}
                />
              ))}
            </div>
          </section>

          {/* audience */}
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-zinc-400">
              Others in the room <span className="font-normal text-zinc-600">· {audience.length}</span>
            </h2>
            <div className="grid grid-cols-4 gap-x-1 gap-y-4 sm:grid-cols-6">
              {audience.map((p) => (
                <ParticipantTile
                  key={p.userId}
                  p={{ ...p, speaking: isSpeaking(p) }}
                  size="md"
                  isHost={false}
                  isMe={p.userId === me?.id}
                  followed={following.has(p.userId)}
                  floatingEmoji={tileReactions[p.userId] ?? null}
                  onClick={() => setSelected(p.userId)}
                />
              ))}
            </div>
            {audience.length === 0 && <p className="text-sm text-zinc-600">No listeners yet — share the room link!</p>}
          </section>
        </div>
      </main>


      {/* bottom bar */}
      <div className="sticky bottom-0 z-30 bg-gradient-to-t from-app via-app/95 to-transparent pt-8">
        <div className="px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {preview && !chatVisible && (
            <button
              onClick={() => setChatOpen(true)}
              className="toast-in mb-3 flex w-full items-center gap-2.5 rounded-2xl border border-white/5 bg-zinc-900/95 px-3 py-2 text-left shadow-xl backdrop-blur lg:hidden"
            >
              <Avatar name={preview.authorName} color={preview.authorColor} photo={preview.authorPhotoUrl} size="xs" />
              <span className="min-w-0 flex-1 truncate text-sm">
                <b className="font-semibold text-zinc-100">{preview.authorName.split(" ")[0]}</b>{" "}
                <span className="text-zinc-300">{preview.text}</span>
              </span>
              <MessageSquare className="h-4 w-4 shrink-0 text-zinc-500" />
            </button>
          )}
          {audio.needsGesture && (
            <button
              onClick={() => void audio.startAudio()}
              className="mb-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-500/15 py-2.5 text-sm font-medium text-sky-300"
            >
              <Volume2 className="h-4 w-4" /> Tap to enable room audio
            </button>
          )}
          {onStage && !meP.muted && audio.micError && (
            <p className="mb-2 text-center text-xs text-amber-400">{audio.micError} — others see you as unmuted, but no audio is being sent.</p>
          )}
          <ReactionBar open={reactOpen} onPick={sendReaction} onClose={() => setReactOpen(false)} />
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-full border border-white/5 bg-zinc-900/90 p-2 shadow-2xl backdrop-blur max-[359px]:gap-1.5 max-[359px]:p-1.5">
            <button onClick={leave} className="shrink-0 whitespace-nowrap rounded-full bg-zinc-800 px-4 py-3 text-sm font-semibold text-red-300 transition hover:bg-zinc-700 max-[359px]:px-3 sm:px-5">
              ✌️ Leave<span className="max-[359px]:hidden"> quietly</span>
            </button>
            <div className="flex min-w-0 items-center gap-2 max-[359px]:gap-1.5 max-[359px]:[&>button]:p-3">
              <button
                onClick={() => setReactOpen((v) => !v)}
                className={cn(
                  "rounded-full p-3.5 transition",
                  reactOpen ? "bg-sky-500 text-on-accent" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
                )}
                aria-label="Send reaction"
                title="Wave & reactions"
              >
                <SmilePlus className="h-5 w-5" />
              </button>
              <button
                onClick={() => setChatOpen(true)}
                className="relative rounded-full bg-zinc-800 p-3.5 text-zinc-200 transition hover:bg-zinc-700 lg:hidden"
                aria-label="Open room chat"
                title="Room chat"
              >
                <MessageSquare className="h-5 w-5" />
                {chatUnread > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-400 px-1 text-[11px] font-bold text-ink">
                    {chatUnread > 99 ? "99+" : chatUnread}
                  </span>
                )}
              </button>
              {amHost && (
                <button onClick={() => setHandsOpen(true)} className="relative rounded-full bg-zinc-800 p-3.5 text-zinc-200 transition hover:bg-zinc-700" aria-label="Raised hands">
                  <span className="text-lg leading-none">🙌</span>
                  {hands.length > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[11px] font-bold text-ink">
                      {hands.length}
                    </span>
                  )}
                </button>
              )}
              {!onStage && (
                <button
                  onClick={toggleHand}
                  className={cn(
                    "rounded-full p-3.5 transition",
                    meP.handRaised ? "bg-amber-400 text-ink hover:bg-amber-300" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
                  )}
                  aria-label={meP.handRaised ? "Lower hand" : "Raise hand"}
                  title={meP.handRaised ? "Lower hand" : "Raise hand"}
                >
                  <Hand className="h-5 w-5" />
                </button>
              )}
              {onStage && (
                <button
                  onClick={toggleMute}

                  className={cn(
                    "relative overflow-hidden rounded-full p-3.5 transition",
                    meP.muted ? "bg-red-500/15 text-red-400 hover:bg-red-500/25" : "bg-emerald-500 text-on-accent hover:bg-emerald-400",
                  )}
                  aria-label={meP.muted ? "Unmute" : "Mute"}
                  aria-pressed={!meP.muted}
                  title={meP.muted ? "Unmute" : "Mute"}
                  data-testid="mic-toggle"
                >
                  {!meP.muted && (
                    <span className="absolute inset-x-0 bottom-0 bg-emerald-300/60 transition-all" style={{ height: `${Math.min(100, localLevel * 400)}%` }} />
                  )}
                  <span className="relative">
                    {meP.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

     </div>

      {/* desktop: persistent chat column */}
      <aside className="hidden lg:block">
        <div className="sticky top-0 flex h-dvh flex-col py-4">
          {isDesktop && (
            <RoomChatPanel
              className="flex-1 overflow-hidden rounded-[2rem] border border-white/5 bg-zinc-900/70 shadow-2xl"
              messages={chat}
              meId={me?.id}
              hostId={room.hostId}
              canModerate={amHost}
              connected={connected}
              onSend={sendChat}
              onDelete={deleteChat}
              onAuthorClick={openAuthor}
              hiddenIds={safety.hidden}
              onReport={(m) => setReportTarget({ type: "message", id: m.id, roomId, label: m.text })}
            />
          )}
        </div>
      </aside>

      {/* mobile: chat drawer (non-blocking for host controls — close it to get back to the stage) */}
      {chatOpen && !isDesktop && (
        <div className="ol-vv-fixed fixed inset-x-0 z-50 flex items-end justify-center" role="dialog" aria-modal aria-label="Room chat">
          <div className="fade-in absolute inset-0 bg-black/25" onClick={() => setChatOpen(false)} />
          <RoomChatPanel
            className="sheet-in relative h-[min(62dvh,calc(var(--ol-vvh,100dvh)-env(safe-area-inset-top,0px)-8px))] w-full max-w-2xl overflow-hidden rounded-t-3xl border border-white/5 bg-zinc-900 pb-[env(safe-area-inset-bottom)] shadow-2xl"
            messages={chat}
            meId={me?.id}
            hostId={room.hostId}
            canModerate={amHost}
            connected={connected}
            onSend={sendChat}
            onDelete={deleteChat}
            onAuthorClick={openAuthor}
            hiddenIds={safety.hidden}
            onReport={(m) => setReportTarget({ type: "message", id: m.id, roomId, label: m.text })}
            onClose={() => setChatOpen(false)}
          />
        </div>
      )}

      <UserActionSheet
        target={selectedP}
        roomId={roomId}
        amHost={amHost}
        onClose={() => setSelected(null)}
        onMessage={(uid) => {
          setSelected(null);
          setDmPeer(uid);
        }}
        blocked={!!selectedP && safety.isBlocked(selectedP.userId)}
        onReport={(p) => {
          setSelected(null);
          setReportTarget({ type: "user", id: p.userId, label: p.name });
        }}
        onBlock={(p) => {
          setSelected(null);
          setBlockTarget({ id: p.userId, name: p.name });
        }}
      />
      <ReportSheet
        target={reportTarget}
        onClose={() => setReportTarget(null)}
        onBlock={(() => {
          const uid = reportTarget?.type === "user" ? reportTarget.id : reportTarget?.type === "message" ? chat.find((m) => m.id === reportTarget.id)?.authorId : undefined;
          const name = reportTarget?.type === "user" ? reportTarget.label : chat.find((m) => m.id === reportTarget?.id)?.authorName;
          if (!uid || uid === me?.id || safety.isBlocked(uid)) return undefined;
          return () => {
            setReportTarget(null);
            setBlockTarget({ id: uid, name: name ?? "this account" });
          };
        })()}
      />
      <BlockConfirm
        user={blockTarget}
        blocked={!!blockTarget && safety.isBlocked(blockTarget.id)}
        onClose={() => setBlockTarget(null)}
        onDone={(b) => blockTarget && toast(b ? `Blocked ${blockTarget.name}` : `Unblocked ${blockTarget.name}`)}
      />

      {/* DM drawer: message someone without leaving the room */}
      {dmPeer && (
        <div className="ol-vv-fixed fixed inset-x-0 z-[55] flex items-end justify-center sm:items-center" role="dialog" aria-modal aria-label="Direct message">
          <div className="fade-in absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setDmPeer(null)} />
          <DmThread
            peerId={dmPeer}
            backStyle="close"
            onBack={() => setDmPeer(null)}
            className="sheet-in relative h-[min(85dvh,calc(var(--ol-vvh,100dvh)-env(safe-area-inset-top,0px)-8px))] w-full max-w-lg overflow-hidden rounded-t-3xl border border-white/5 bg-zinc-900 shadow-2xl sm:h-[75dvh] sm:rounded-3xl"
          />
        </div>
      )}

      {/* raised hands queue (host) */}
      <Sheet open={handsOpen} onClose={() => setHandsOpen(false)} title={`Raised hands · ${hands.length}`}>
        {hands.length === 0 ? (
          <div className="py-8 text-center text-zinc-500">
            <div className="mb-2 text-3xl">🙌</div>
            No hands raised right now.
          </div>
        ) : (
          <ul className="space-y-2">
            {hands.map((p) => (
              <li key={p.userId} className="flex items-center gap-3 rounded-2xl bg-zinc-950/60 p-3">
                <Avatar name={p.name} color={p.color} photo={p.photoUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-xs text-zinc-500">raised {timeAgo(p.handRaisedAt ?? serverNow()).replace(/^(\d.*)$/, "$1 ago")}</div>
                </div>
                <button onClick={() => invite(p.userId)} className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-emerald-400">
                  <Mic className="h-4 w-4" /> Invite
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      <InviteToRoomSheet roomId={roomId} open={inviteOpen} onClose={() => setInviteOpen(false)} exclude={new Set(participants.map((p) => p.userId))} />

      {/* room menu */}
      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Room">
        <div className="space-y-1">
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                toast("🔗 Room link copied");
              } catch {
                toast(window.location.href);
              }
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium hover:bg-white/5"
          >
            <Link2 className="h-4 w-4" /> Copy room link
          </button>
          {onStage && !amHost && (
            <button
              onClick={() => {
                socket?.emit("stage:toAudience", { roomId, userId: me?.id });
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium hover:bg-white/5"
            >
              <ChevronDown className="h-4 w-4" /> Move myself to audience
            </button>
          )}
          {!amHost && (
            <button
              onClick={() => {
                setMenuOpen(false);
                setReportTarget({ type: "room", id: roomId, label: room.title });
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-red-400 hover:bg-red-500/10"
            >
              <Flag className="h-4 w-4" /> Report room
            </button>
          )}
          {amHost && (
            <button
              onClick={() => {
                setMenuOpen(false);
                setConfirmEnd(true);
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-red-400 hover:bg-red-500/10"
            >
              <Power className="h-4 w-4" /> End room for everyone
            </button>
          )}
        </div>
      </Sheet>

      <Sheet open={confirmEnd} onClose={() => setConfirmEnd(false)} title="End this room?">
        <p className="mb-5 text-sm text-zinc-400">Everyone will be removed and the room will disappear from the hallway.</p>
        <div className="flex gap-2">
          <button onClick={() => setConfirmEnd(false)} className="flex-1 rounded-full border border-white/15 py-3 text-sm font-semibold hover:bg-white/5">
            Cancel
          </button>
          <button onClick={endRoom} className="flex-1 rounded-full bg-red-500 py-3 text-sm font-semibold text-on-color hover:bg-red-400">
            End room
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function AudioStatusPill({ status, error }: { status: string; error: string | null }) {
  if (status === "connected" || status === "off") return null;
  const map: Record<string, { cls: string; text: string }> = {
    connecting: { cls: "bg-zinc-800 text-zinc-400", text: "Connecting audio…" },
    unavailable: {
      cls: "bg-amber-400/10 text-amber-400",
      text: "🔇 Live audio is off — this server has no LiveKit credentials. Stage, hands and chat still work.",
    },
    error: { cls: "bg-amber-400/10 text-amber-300", text: "🔇 Live audio is reconnecting. Room is still open — stage, hands and chat work." },
  };
  const m = map[status];
  if (!m) return null;
  return <p className={cn("mt-3 rounded-2xl px-3 py-2 text-xs leading-snug", m.cls)}>{m.text}</p>;
}
