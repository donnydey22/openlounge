"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient } from "@/lib/realtime";
import type { DirectMessage, Me, RoomSummary } from "@/lib/types";
import { clearToken, loadToken, saveToken } from "@/lib/session";

type Status = "booting" | "signedOut" | "connecting" | "ready";

interface Toast {
  id: number;
  message: string;
  href?: string;
}

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
  /** Called by the auth flow once the server has issued a session token */
  completeLogin(token: string, session: SessionPayload, opts?: { onboarding?: boolean }): void;
  finishOnboarding(): void;
  signOut(): Promise<void>;
  request<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<T>;
  follow(userId: string, follow: boolean): Promise<void>;
  updateMe(patch: { name?: string; bio?: string; color?: string; username?: string; interests?: string[] }): Promise<void>;
  setPhoto(photo: string | null): Promise<void>;
  toast(message: string, href?: string): void;
  /** User ids currently online (app open + connected), pushed live over the WebSocket */
  onlineIds: Set<string>;
  isOnline(userId: string): boolean;
  /** When an offline user was last active (null = online or unknown); `fallback` = value from a fetched PublicUser */
  lastSeenAt(userId: string, fallback?: number | null): number | null;
}

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
  const activeDm = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const meRef = useRef<Me | null>(null);
  meRef.current = me;
  const toastId = useRef(0);

  const setActiveDm = useCallback((peerId: string | null) => {
    activeDm.current = peerId;
  }, []);

  const toast = useCallback((message: string, href?: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, message, href }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

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
    const resume = () => {
      const t = tokenRef.current ?? loadToken();
      if (!t) return;
      s.request<({ ok: true } & SessionPayload) | { ok: false }>("session:resume", { token: t })
        .then((res) => {
          if (!res?.ok) return dropSession();
          applySession(res);
          if (document.visibilityState === "hidden") reportVisibility();
        })
        .catch(() => {
          /* connection dropped mid-request; we'll resume on reconnect */
        });
    };
    s.on("connect", () => {
      setConnected(true);
      resume();
    });
    s.on("disconnect", () => setConnected(false));
    s.on("rooms:update", (list: RoomSummary[]) => setRooms(list));
    s.on("toast", ({ message }: { message: string }) => toast(message));
    s.on("follows:update", ({ following }: { following: string[] }) => setFollowing(new Set(following)));
    s.on("me:update", ({ user }: { user: Me }) => setMe(user));
    s.on("dm:unread", ({ count }: { count: number }) => setUnreadDms(count));
    s.on("presence:snapshot", ({ onlineIds: ids, lastSeen: seen }: { onlineIds: string[]; lastSeen?: Record<string, number> }) => {
      setOnlineIds(new Set(ids));
      if (seen) setLastSeen(new Map(Object.entries(seen)));
    });
    s.on("presence:update", ({ userId, online, lastSeenAt }: { userId: string; online: boolean; lastSeenAt: number | null }) => {
      setOnlineIds((prev) => {
        if (prev.has(userId) === online) return prev;
        const next = new Set(prev);
        if (online) next.add(userId);
        else next.delete(userId);
        return next;
      });
      if (!online && lastSeenAt) setLastSeen((prev) => new Map(prev).set(userId, lastSeenAt));
    });
    document.addEventListener("visibilitychange", reportVisibility);
    s.on("dm:message", (msg: DirectMessage) => {
      if (msg.toId !== meRef.current?.id) return;
      const active = activeDm.current;
      if (active === msg.fromId || active === "*") return;
      const preview = msg.text.length > 60 ? msg.text.slice(0, 60) + "…" : msg.text;
      toast(`💬 ${msg.fromName}: ${preview}`, `/messages/${msg.fromId}`);
    });
    s.connect();
    setSocket(s);
    return () => {
      document.removeEventListener("visibilitychange", reportVisibility);
      s.removeAllListeners();
      s.close();
    };
  }, [applySession, dropSession, toast]);

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
      completeLogin,
      finishOnboarding,
      signOut,
      request,
      follow,
      updateMe,
      setPhoto,
      toast,
      onlineIds,
      isOnline,
      lastSeenAt,
    }),
    [status, connected, socket, me, rooms, following, toasts, unreadDms, onboarding, setActiveDm, completeLogin, finishOnboarding, signOut, request, follow, updateMe, setPhoto, toast, onlineIds, isOnline, lastSeenAt],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
