"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bell, Share } from "lucide-react";
import { useApp } from "./AppProvider";
import type { ChatMessage, DirectMessage, RoomPresenceEvent, RoomState } from "@/lib/types";
import { firstName } from "@/lib/utils";
import {
  getPermission,
  getSupport,
  getVersion,
  osEnabled,
  pageHidden,
  registerServiceWorker,
  requestPermission,
  routeTo,
  setNavigator,
  shouldPrompt,
  showOsNotification,
  subscribe,
  writePref,
} from "@/lib/notify";

// ----- rules (exported for docs/tests) -----
/** joins arriving within this window are folded into one "Alex and 3 others joined" notice */
export const JOIN_DEBOUNCE_MS = 1500;
/** a join notice updates silently (same tag, no new sound) while its batch is younger than this */
export const JOIN_BATCH_MS = 60_000;
/** speaking: at most once per person per this long… */
export const SPEAK_PER_PERSON_MS = 2 * 60_000;
/** …only after they've been silent at least this long… */
export const SPEAK_SILENCE_GAP_MS = 20_000;
/** …and at most one speaking notice per room in this window (several people taking turns) */
export const SPEAK_ROOM_MS = 30_000;
/** chat / DM notices with the same tag only re-alert (sound/vibrate) after this long */
const REALERT_MS = 10_000;

interface RoomCtx {
  room: RoomState;
  meId: string;
}

interface NotifierCtx {
  /** The room page tells us which room you're in (title, roles, participants) */
  setRoomContext(ctx: RoomCtx | null): void;
  /** The room page reports LiveKit active speakers (user ids) on every change */
  reportSpeaking(roomId: string, speakingIds: string[]): void;
}

const Ctx = createContext<NotifierCtx>({ setRoomContext: () => {}, reportSpeaking: () => {} });
export function useNotifier() {
  return useContext(Ctx);
}

/** Re-renders when the notification preference / permission changes. */
export function useNotificationState() {
  useSyncExternalStore(subscribe, getVersion, () => 0);
  // permission can also change in browser settings; re-check on focus
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    window.addEventListener("focus", f);
    document.addEventListener("visibilitychange", f);
    return () => {
      window.removeEventListener("focus", f);
      document.removeEventListener("visibilitychange", f);
    };
  }, []);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return { support: "unsupported" as const, permission: "unsupported" as const, enabled: false };
  return { support: getSupport(), permission: getPermission(), enabled: osEnabled() };
}

export function Notifier({ children }: { children: React.ReactNode }) {
  const { socket, me, status, onboarding, banner, getActiveDm } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const roomCtx = useRef<RoomCtx | null>(null);
  const meId = me?.id;
  const meIdRef = useRef(meId);
  meIdRef.current = meId;

  // tag → last time it made a sound
  const lastAlert = useRef(new Map<string, number>());
  const realert = (tag: string, gap = REALERT_MS) => {
    const now = Date.now();
    const prev = lastAlert.current.get(tag) ?? 0;
    if (now - prev < gap) return false;
    lastAlert.current.set(tag, now);
    return true;
  };
  // unseen counts while hidden (reset when you come back)
  const unseen = useRef(new Map<string, number>());
  const bump = (tag: string) => {
    const n = (unseen.current.get(tag) ?? 0) + 1;
    unseen.current.set(tag, n);
    return n;
  };

  // ---- service worker + notification clicks ----
  useEffect(() => {
    const go = (url: string) => routeTo(url, (h) => router.push(h));
    setNavigator(go);
    if (getSupport() === "supported" && getPermission() === "granted") void registerServiceWorker();
    let onMsg: ((e: MessageEvent) => void) | null = null;
    try {
      if ("serviceWorker" in navigator) {
        onMsg = (e: MessageEvent) => {
          const d = e.data as { type?: string; url?: string } | null;
          if (d?.type === "openlounge:navigate" && typeof d.url === "string") go(d.url);
        };
        navigator.serviceWorker.addEventListener("message", onMsg);
      }
    } catch {
      onMsg = null;
    }
    const onVis = () => {
      if (!pageHidden()) unseen.current.clear();
      // a fresh join batch per visible/hidden period: an OS notification shouldn't repeat people
      // already announced by an in-app banner (and vice versa); keep joins not yet shown
      const b = joinBatch.current;
      if (b) {
        const pending = b.ids.slice(0, b.ids.length - b.flushed);
        joinBatch.current = pending.length ? { ...b, startedAt: Date.now(), alerted: false, flushed: 0, ids: pending } : null;
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try {
        if (onMsg) navigator.serviceWorker.removeEventListener("message", onMsg);
      } catch {
        /* ignore */
      }
    };
  }, [router]);

  // ---- joins (host / speaker only), batched ----
  const joinBatch = useRef<{ roomId: string; startedAt: number; alerted: boolean; flushed: number; ids: string[]; names: Map<string, RoomPresenceEvent> } | null>(null);
  const joinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushJoins = useCallback(() => {
    joinTimer.current = null;
    const b = joinBatch.current;
    const ctx = roomCtx.current;
    if (!b || !ctx || ctx.room.id !== b.roomId) return;
    b.flushed = b.ids.length;
    const myRole = ctx.room.participants.find((p) => p.userId === ctx.meId)?.role;
    if (!myRole || myRole === "listener") return;
    const present = new Map(ctx.room.participants.map((p) => [p.userId, p]));
    // still in the room, not a demo bot
    const ids = b.ids.filter((id) => present.has(id) && !present.get(id)!.isBot);
    if (ids.length === 0) return;
    const first = b.names.get(ids[0])!;
    const who = firstName(first.name);
    const others = ids.length - 1;
    const roomTitle = ctx.room.title;
    const title =
      others === 0 ? `${who} joined ${roomTitle}` : others === 1 ? `${who} and ${firstName(b.names.get(ids[1])!.name)} joined ${roomTitle}` : `${who} and ${others} others joined ${roomTitle}`;
    const url = `/room/${b.roomId}`;
    const tag = `join:${b.roomId}`;
    if (pageHidden() && osEnabled()) {
      // the first notice of a batch alerts; later joins update the same notification silently
      const renotify = !b.alerted;
      b.alerted = true;
      void showOsNotification({ title, body: others ? "Tap to say hi" : "Tap to open the room", tag, url, renotify });
      return;
    }
    if (!pageHidden()) {
      const body = others > 1 ? ids.slice(1, 4).map((id) => firstName(b.names.get(id)!.name)).join(", ") + (others > 3 ? "…" : "") : undefined;
      banner({ title, body, avatar: { name: first.name, color: first.color, photo: first.photoUrl }, href: url, key: tag });
    }
  }, [banner]);

  // ---- speaking ----
  const speakState = useRef({
    roomId: "",
    speaking: new Set<string>(),
    silentSince: new Map<string, number>(),
    lastNotified: new Map<string, number>(),
    lastRoomNotice: 0,
  });

  const reportSpeaking = useCallback((roomId: string, ids: string[]) => {
    const st = speakState.current;
    const now = Date.now();
    if (st.roomId !== roomId) {
      st.roomId = roomId;
      st.speaking = new Set();
      st.silentSince = new Map();
      st.lastNotified = new Map();
      st.lastRoomNotice = 0;
    }
    const next = new Set(ids);
    for (const id of st.speaking) if (!next.has(id)) st.silentSince.set(id, now);
    const started = ids.filter((id) => !st.speaking.has(id));
    st.speaking = next;
    const ctx = roomCtx.current;
    if (!ctx || ctx.room.id !== roomId) return;
    for (const id of started) {
      if (id === ctx.meId) continue; // never for yourself
      const silent = st.silentSince.get(id);
      const gapOk = silent === undefined || now - silent >= SPEAK_SILENCE_GAP_MS; // first time we hear them counts as after a gap
      const personOk = now - (st.lastNotified.get(id) ?? 0) >= SPEAK_PER_PERSON_MS;
      const roomOk = now - st.lastRoomNotice >= SPEAK_ROOM_MS;
      if (!gapOk || !personOk || !roomOk) continue;
      if (!pageHidden() || !osEnabled()) continue; // only when the tab is hidden: otherwise it's noise
      const p = ctx.room.participants.find((x) => x.userId === id);
      if (!p || p.isBot) continue;
      st.lastNotified.set(id, now);
      st.lastRoomNotice = now;
      void showOsNotification({
        title: `${firstName(p.name)} is speaking`,
        body: `in ${ctx.room.title}`,
        tag: `speak:${roomId}`,
        url: `/room/${roomId}`,
        renotify: true,
      });
    }
  }, []);

  const setRoomContext = useCallback((ctx: RoomCtx | null) => {
    roomCtx.current = ctx;
    if (!ctx) {
      joinBatch.current = null;
      if (joinTimer.current) clearTimeout(joinTimer.current);
      joinTimer.current = null;
    }
  }, []);

  // ---- socket events ----
  useEffect(() => {
    if (!socket) return;

    const onPresence = (ev: RoomPresenceEvent) => {
      if (ev.type !== "join" || ev.userId === meIdRef.current) return;
      const ctx = roomCtx.current;
      if (!ctx || ctx.room.id !== ev.roomId) return;
      const now = Date.now();
      let b = joinBatch.current;
      if (!b || b.roomId !== ev.roomId || now - b.startedAt > JOIN_BATCH_MS) {
        b = joinBatch.current = { roomId: ev.roomId, startedAt: now, alerted: false, flushed: 0, ids: [], names: new Map() };
      }
      if (!b.names.has(ev.userId)) b.ids.unshift(ev.userId); // newest first: "Alex and 3 others"
      b.names.set(ev.userId, ev);
      if (!joinTimer.current) joinTimer.current = setTimeout(flushJoins, JOIN_DEBOUNCE_MS);
    };

    const onChat = (m: ChatMessage) => {
      const ctx = roomCtx.current;
      if (!ctx || m.roomId !== ctx.room.id || m.authorId === meIdRef.current || m.authorIsBot) return;
      // visible tab: the room already shows the message (chat panel / inline preview above the controls)
      if (!pageHidden() || !osEnabled()) return;
      const tag = `chat:${m.roomId}`;
      const n = bump(tag);
      void showOsNotification({
        title: n > 1 ? `${ctx.room.title} · ${n} new messages` : ctx.room.title,
        body: `${firstName(m.authorName)}: ${m.text}`,
        tag,
        url: `/room/${m.roomId}`,
        renotify: realert(tag),
      });
    };

    const onDm = (msg: DirectMessage) => {
      if (!meIdRef.current || msg.toId !== meIdRef.current || msg.fromId === meIdRef.current) return;
      const url = `/messages/${msg.fromId}`;
      const tag = `dm:${msg.fromId}`;
      if (pageHidden()) {
        if (osEnabled()) {
          const n = bump(tag);
          void showOsNotification({
            title: n > 1 ? `${msg.fromName} · ${n} new messages` : msg.fromName,
            body: msg.text,
            tag,
            url,
            renotify: realert(tag),
          });
          return;
        }
        // no OS notifications: fall through to the in-app banner (old behaviour)
      } else if (getActiveDm() === msg.fromId) {
        return; // you're looking at that thread right now
      }
      // tap → the thread (opens scrolled to the newest message); inside a room it opens the DM drawer
      banner({ title: msg.fromName, body: msg.text, avatar: { name: msg.fromName, color: msg.fromColor, userId: msg.fromId }, href: url, key: tag });
    };

    socket.on("room:presence", onPresence);
    socket.on("chat:message", onChat);
    socket.on("dm:message", onDm);
    return () => {
      socket.off("room:presence", onPresence);
      socket.off("chat:message", onChat);
      socket.off("dm:message", onDm);
      if (joinTimer.current) clearTimeout(joinTimer.current);
      joinTimer.current = null;
    };
  }, [socket, banner, getActiveDm, flushJoins]);

  const value = useMemo(() => ({ setRoomContext, reportSpeaking }), [setRoomContext, reportSpeaking]);
  const promptAllowed = status === "ready" && !onboarding && !!meId && !pathname?.startsWith("/room/");

  return (
    <Ctx.Provider value={value}>
      {children}
      {promptAllowed && <NotificationPrompt />}
    </Ctx.Provider>
  );
}

/** First-visit card: "Turn on notifications?" (Enable / Not now), or the iPhone Home Screen hint. */
function NotificationPrompt() {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [support, setSupport] = useState<ReturnType<typeof getSupport>>("unsupported");

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    try {
      // permission already granted (e.g. in another tab / site settings): nothing to ask
      if (getSupport() === "supported" && getPermission() === "granted") return;
      if (getSupport() === "supported" && getPermission() === "denied") return;
      if (!shouldPrompt()) return;
      setSupport(getSupport());
      t = setTimeout(() => setOpen(true), 1200); // let the hallway settle first
    } catch {
      /* never block the app */
    }
    return () => {
      if (t) clearTimeout(t);
    };
  }, []);

  const close = () => {
    setLeaving(true);
    setTimeout(() => setOpen(false), 200);
  };

  if (!open) return null;
  const ios = support === "ios-install";
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[58] flex justify-center px-3"
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <div
        role="dialog"
        aria-label={ios ? "Get notifications on iPhone" : "Turn on notifications"}
        data-testid="notif-prompt"
        className={
          "pointer-events-auto w-full max-w-[400px] rounded-[1.75rem] border border-white/10 bg-zinc-900/90 p-4 shadow-2xl backdrop-blur-xl backdrop-saturate-150 " +
          (leaving ? "banner-out" : "sheet-in")
        }
      >
        <div className="flex items-start gap-3">
          <span className="openlounge-hex flex h-11 w-11 shrink-0 items-center justify-center bg-emerald-500 text-on-accent">
            {ios ? <Share className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] leading-snug font-semibold">{ios ? "Get notifications on iPhone" : "Turn on notifications?"}</h2>
            <p className="mt-0.5 text-[13px] leading-snug text-zinc-400">
              {ios ? (
                <>
                  Add Open Lounge to your Home Screen: tap <b className="font-semibold text-zinc-300">Share</b>, then{" "}
                  <b className="font-semibold text-zinc-300">Add to Home Screen</b>. Open it from there to turn on notifications.
                </>
              ) : (
                "Know when people join your room, send you a message, or start talking while you're away."
              )}
            </p>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          {ios ? (
            <button
              onClick={() => {
                writePref("later");
                close();
              }}
              className="flex-1 rounded-full bg-emerald-500 py-2.5 text-sm font-semibold text-on-accent hover:bg-emerald-400"
            >
              Got it
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  writePref("later");
                  close();
                }}
                className="flex-1 rounded-full border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:bg-white/5"
              >
                Not now
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  // the native prompt only ever comes from this tap (user-gesture requirement)
                  await requestPermission();
                  setBusy(false);
                  close();
                }}
                className="flex-1 rounded-full bg-emerald-500 py-2.5 text-sm font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-60"
              >
                Enable
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
