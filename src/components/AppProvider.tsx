"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient } from "@/lib/realtime";
import type { DirectMessage, Me, PresenceStatus, RoomSummary } from "@/lib/types";
import { clearToken, loadToken, saveToken } from "@/lib/session";

type Status = "booting" | "signedOut" | "connecting" | "ready";

/** Who/what a banner is about: a person (squircle avatar) or the app itself (system events). */
export type BannerAvatar = { name: string; color: string; photo?: string | null; /** shows their live online dot */ userId?: string } | "app";

/**
 * One in-app notice. "plain" = short status pill (errors, confirmations), "notice" = Clubhouse-style
 * notification banner (avatar + bold title + one muted line). Only one is on screen at a time;
 * the rest wait in a short queue.
 */
export interface Toast {
  id: number;
  kind: "plain" | "notice";
  message: string;
  body?: string;
  href?: string;
  avatar?: BannerAvatar;
  /** same key = replace that banner in place instead of queueing another (e.g. "Alex and 2 others joined") */
  key?: string;
  /** bumped when the banner's content is replaced, so its timer restarts */
  rev: number;
}

export interface BannerInput {
  title: string;
  body?: string;
  href?: string;
  avatar?: BannerAvatar;
  key?: string;
}

/** Current banner + up to this many waiting */
const MAX_TOASTS = 3;

export interface SessionPayload {
  user: Me;
  following: string[];
  unreadDms: number;
}

interface AppCtx {
  status: Status;
  connected: boolean;
  socket: RealtimeClient | null;
  me: Me | null;
  rooms: RoomSummary[];
  following: Set<string>;
  toasts: Toast[];
  /** Total unread direct messages */
  unreadDms: number;
  /** True while a brand-new account is finishing onboarding (interests / follow suggestions) */
  onboarding: boolean;
  /** DM thread currently on screen ("*" = conversation list) — suppresses DM toasts for it */
  setActiveDm(peerId: string | null): void;
  getActiveDm(): string | null;
  /** Called by the auth flow once the server has issued a session token */
  completeLogin(token: string, session: SessionPayload, opts?: { onboarding?: boolean }): void;
  finishOnboarding(): void;
  signOut(): Promise<void>;
  request<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<T>;
  follow(userId: string, follow: boolean): Promise<void>;
  updateMe(patch: { name?: string; bio?: string; color?: string; username?: string; interests?: string[] }): Promise<void>;
  setPhoto(photo: string | null): Promise<void>;
  toast(message: string, href?: string): void;
  /** Clubhouse-style in-app notification banner (visible tab) */
  banner(input: BannerInput): void;
  dismissToast(id: number): void;
  /** User ids currently online (app open + connected), pushed live over the WebSocket */
  onlineIds: Set<string>;
  isOnline(userId: string): boolean;
  /** When an offline user was last active (null = online or unknown); `fallback` = value from a fetched PublicUser */
  lastSeenAt(userId: string, fallback?: number | null): number | null;
  /** Live presence: "online" (green), "away" (amber: connected but backgrounded), "offline" (no dot) */
  presenceOf(userId: string): PresenceStatus;
  /** True only once the socket has been down for more than a few seconds (drives a subtle indicator) */
  offline: boolean;
}

/** Disconnected longer than this → show the subtle offline indicator (shorter blips stay invisible). */
const OFFLINE_HINT_MS = 5_000;

const Ctx = createContext<AppCtx | null>(null);

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [socket, setSocket] = useState<RealtimeClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unreadDms, setUnreadDms] = useState(0);
  const [onboarding, setOnboarding] = useState(false);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [lastSeen, setLastSeen] = useState<Map<string, number>>(new Map());
  const [awayIds, setAwayIds] = useState<Set<string>>(new Set());
  const [offline, setOffline] = useState(false);
  const activeDm = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const meRef = useRef<Me | null>(null);
  meRef.current = me;
  const toastId = useRef(0);

  const setActiveDm = useCallback((peerId: string | null) => {
    activeDm.current = peerId;
  }, []);

  const getActiveDm = useCallback(() => activeDm.current, []);

  // One queue for every in-app notice (timers live in <Toasts/>, which shows only the first item).
  const pushToast = useCallback((t: Omit<Toast, "id" | "rev">) => {
    setToasts((list) => {
      if (t.key) {
        const i = list.findIndex((x) => x.key === t.key);
        if (i >= 0) {
          const next = [...list];
          next[i] = { ...list[i], ...t, rev: list[i].rev + 1 };
          return next;
        }
      }
      const item: Toast = { ...t, id: ++toastId.current, rev: 0 };
      const next = [...list, item];
      // keep the visible one, drop the oldest waiting ones
      return next.length > MAX_TOASTS ? [next[0], ...next.slice(next.length - (MAX_TOASTS - 1))] : next;
    });
  }, []);

  const toast = useCallback((message: string, href?: string) => pushToast({ kind: "plain", message, href }), [pushToast]);

  const banner = useCallback(
    (b: BannerInput) => pushToast({ kind: "notice", message: b.title, body: b.body, href: b.href, avatar: b.avatar, key: b.key }),
    [pushToast],
  );

  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((x) => x.id !== id)), []);

  const applySession = useCallback((s: SessionPayload) => {
    setMe(s.user);
    setFollowing(new Set(s.following));
    setUnreadDms(s.unreadDms ?? 0);
  }, []);

  const dropSession = useCallback(() => {
    clearToken();
    setToken(null);
    setMe(null);
    setFollowing(new Set());
    setUnreadDms(0);
    setOnboarding(false);
    setOnlineIds(new Set());
    setAwayIds(new Set());
    setLastSeen(new Map());
  }, []);

  // One socket for the app's lifetime; it's used for auth (pre-login) and everything after.
  useEffect(() => {
    const stored = loadToken();
    setToken(stored);
    setBooted(true);

    const s = new RealtimeClient();
    // Tell the server whether the app is in the foreground (Android WebView backgrounding, hidden tabs)
    const reportVisibility = () => {
      if (!tokenRef.current && !loadToken()) return;
      s.emit("presence:visible", { visible: document.visibilityState !== "hidden" });
    };
    // ---- DM catch-up: nothing is lost across a reconnect, nothing is shown twice ----
    // syncedAt = server time up to which we know we received every pushed DM (last DM / heartbeat).
    let syncedAt = 0;
    const seenDms = new Set<string>();
    const noteDm = (m: DirectMessage) => {
      seenDms.add(m.id);
      if (seenDms.size > 500) seenDms.delete(seenDms.values().next().value as string);
      syncedAt = Math.max(syncedAt, m.createdAt);
    };
    s.on("dm:message", noteDm);
    const markSynced = () =>
      s.request<{ ok: boolean; now?: number }>("ping", {}, 5000)
        .then((r) => r?.now && (syncedAt = Math.max(syncedAt, r.now)))
        .catch(() => {});
    const catchUp = async () => {
      if (!syncedAt) return void markSynced(); // first session on this page: nothing to catch up on
      const after = syncedAt - 2_000; // small overlap for clock/ordering jitter; dedup by id below
      try {
        const r = await s.request<{ ok: boolean; messages?: DirectMessage[] }>("dm:since", { after });
        for (const m of r?.messages ?? []) if (!seenDms.has(m.id)) s.dispatch("dm:message", { ...m, catchUp: true });
      } catch {
        /* dropped again — next reconnect retries from the same point */
      }
      void markSynced();
    };
    const syncTimer = setInterval(() => {
      if (s.connected && meRef.current && document.visibilityState !== "hidden") void markSynced();
    }, 60_000);
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    const resume = () => {
      const t = tokenRef.current ?? loadToken();
      if (!t) return;
      s.request<({ ok: true } & SessionPayload) | { ok: false }>("session:resume", { token: t })
        .then((res) => {
          if (!res?.ok) return dropSession();
          applySession(res);
          if (document.visibilityState === "hidden") reportVisibility();
          void catchUp();
        })
        .catch(() => {
          /* connection dropped mid-request; we'll resume on reconnect */
        });
    };
    s.on("connect", () => {
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = null;
      setOffline(false);
      setConnected(true);
      resume();
    });
    s.on("disconnect", () => {
      setConnected(false);
      if (!offlineTimer) offlineTimer = setTimeout(() => setOffline(true), OFFLINE_HINT_MS);
    });
    s.on("rooms:update", (list: RoomSummary[]) => setRooms(list));
    // server-side system notices (new follower, host handover, raised hand…) → banner with the app icon
    s.on("toast", ({ message }: { message: string }) => banner({ title: message, avatar: "app" }));
    s.on("follows:update", ({ following }: { following: string[] }) => setFollowing(new Set(following)));
    s.on("me:update", ({ user }: { user: Me }) => setMe(user));
    s.on("dm:unread", ({ count }: { count: number }) => setUnreadDms(count));
    s.on("presence:snapshot", ({ onlineIds: ids, awayIds: away, lastSeen: seen }: { onlineIds: string[]; awayIds?: string[]; lastSeen?: Record<string, number> }) => {
      setOnlineIds(new Set(ids));
      setAwayIds(new Set(away ?? []));
      if (seen) setLastSeen(new Map(Object.entries(seen)));
    });
    const toggle = (set: Set<string>, id: string, on: boolean) => {
      if (set.has(id) === on) return set;
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    };
    s.on("presence:update", ({ userId, online, status, lastSeenAt }: { userId: string; online: boolean; status?: PresenceStatus; lastSeenAt: number | null }) => {
      const st: PresenceStatus = status ?? (online ? "online" : "offline");
      setOnlineIds((prev) => toggle(prev, userId, st === "online"));
      setAwayIds((prev) => toggle(prev, userId, st === "away"));
      if (st !== "online" && lastSeenAt) setLastSeen((prev) => new Map(prev).set(userId, lastSeenAt));
    });
    document.addEventListener("visibilitychange", reportVisibility);
    // dm:message notifications (banner / OS notification) live in <Notifier/>
    s.connect();
    setSocket(s);
    return () => {
      clearInterval(syncTimer);
      if (offlineTimer) clearTimeout(offlineTimer);
      document.removeEventListener("visibilitychange", reportVisibility);
      s.removeAllListeners();
      s.close();
    };
  }, [applySession, dropSession, banner]);

  const request = useCallback(
    async <T,>(event: string, payload?: unknown): Promise<T> => {
      if (!socket) throw new Error("Not connected");
      const res = await socket.request<{ ok?: boolean; error?: string }>(event, payload ?? {});
      if (res && res.ok === false) throw new Error(res.error || "Something went wrong");
      return res as T;
    },
    [socket],
  );

  const completeLogin = useCallback(
    (t: string, session: SessionPayload, opts?: { onboarding?: boolean }) => {
      saveToken(t);
      setToken(t);
      applySession(session);
      setOnboarding(!!opts?.onboarding);
    },
    [applySession],
  );

  const finishOnboarding = useCallback(() => setOnboarding(false), []);

  const signOut = useCallback(async () => {
    try {
      await socket?.request("session:logout", {}, 3000);
    } catch {
      /* offline: token is still dropped locally */
    }
    dropSession();
  }, [socket, dropSession]);

  const follow = useCallback(
    async (userId: string, f: boolean) => {
      setFollowing((prev) => {
        const next = new Set(prev);
        if (f) next.add(userId);
        else next.delete(userId);
        return next;
      });
      try {
        const res = await request<{ following: string[] }>("user:follow", { userId, follow: f });
        setFollowing(new Set(res.following));
      } catch (e) {
        toast((e as Error).message);
      }
    },
    [request, toast],
  );

  const updateMe = useCallback(
    async (patch: { name?: string; bio?: string; color?: string; username?: string; interests?: string[] }) => {
      const res = await request<{ user: Me }>("user:update", patch);
      setMe(res.user);
    },
    [request],
  );

  const setPhoto = useCallback(
    async (photo: string | null) => {
      const res = await request<{ user: Me }>("user:photo", { photo });
      setMe(res.user);
    },
    [request],
  );

  const isOnline = useCallback((userId: string) => onlineIds.has(userId) || (me?.id === userId && connected), [onlineIds, me?.id, connected]);
  const presenceOf = useCallback(
    (userId: string): PresenceStatus =>
      onlineIds.has(userId) || (me?.id === userId && connected) ? "online" : awayIds.has(userId) ? "away" : "offline",
    [onlineIds, awayIds, me?.id, connected],
  );
  const lastSeenAt = useCallback(
    (userId: string, fallback?: number | null) => (onlineIds.has(userId) ? null : (lastSeen.get(userId) ?? fallback ?? null)),
    [onlineIds, lastSeen],
  );

  const status: Status = !booted ? "booting" : !token ? "signedOut" : me ? "ready" : "connecting";

  const value = useMemo<AppCtx>(
    () => ({
      status,
      connected,
      socket,
      me,
      rooms,
      following,
      toasts,
      unreadDms,
      onboarding,
      setActiveDm,
      getActiveDm,
      completeLogin,
      finishOnboarding,
      signOut,
      request,
      follow,
      updateMe,
      setPhoto,
      toast,
      banner,
      dismissToast,
      onlineIds,
      isOnline,
      lastSeenAt,
      presenceOf,
      offline,
    }),
    [status, connected, socket, me, rooms, following, toasts, unreadDms, onboarding, setActiveDm, getActiveDm, completeLogin, finishOnboarding, signOut, request, follow, updateMe, setPhoto, toast, banner, dismissToast, onlineIds, isOnline, lastSeenAt, presenceOf, offline],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
