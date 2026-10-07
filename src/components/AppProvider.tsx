"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NATIVE_VISIBILITY_EVENT, RealtimeClient, appVisible } from "@/lib/realtime";
import type { DirectMessage, Me, PresenceStatus, RoomSummary } from "@/lib/types";
import { clearToken, hydrateFromNative, loadCreds, loadToken, saveCreds } from "@/lib/session";
import { SignedOutError, getAccessToken, logout, refreshSession, validateStoredSession } from "@/lib/auth";
import { FriendlyError, GENERIC_COPY, NETWORK_COPY, friendlyMessage, isTransient, toFriendly } from "@/lib/errors";

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
  /** first rooms:update received (hallway shows skeletons until then) */
  roomsLoaded: boolean;
  following: Set<string>;
  toasts: Toast[];
  /** Total unread direct messages */
  unreadDms: number;
  /** True while a brand-new account is finishing onboarding (interests / follow suggestions) */
  onboarding: boolean;
  /** DM thread currently on screen ("*" = conversation list) — suppresses DM toasts for it */
  setActiveDm(peerId: string | null): void;
  getActiveDm(): string | null;
  /** Called by the auth flow once the server has issued a session (refresh token + access token) */
  completeLogin(token: string, session: SessionPayload & { access?: string; accessExpiresAt?: number }, opts?: { onboarding?: boolean }): void;
  finishOnboarding(): void;
  signOut(): Promise<void>;
  request<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<T>;
  follow(userId: string, follow: boolean): Promise<void>;
  updateMe(patch: { name?: string; bio?: string; color?: string; username?: string; interests?: string[] }): Promise<void>;
  setPhoto(photo: string | null): Promise<void>;
  toast(message: string, href?: string): void;
  /**
   * A user action failed. Connectivity hiccups and technical failures stay silent (the action is retried or the
   * UI simply stays as it was); only a human message from the server ("Only the host can do that") is shown.
   */
  reportError(e: unknown): void;
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

/** Resolve true once the socket is (re)connected, false after `ms`. */
function waitConnected(s: RealtimeClient, ms: number): Promise<boolean> {
  if (s.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(timer);
      s.off("connect", onConnect);
      // give the automatic session:resume a moment to land
      setTimeout(() => resolve(v), v ? 300 : 0);
    };
    const onConnect = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    s.on("connect", onConnect);
  });
}

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
  const [roomsLoaded, setRoomsLoaded] = useState(false);
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
  const resumeRef = useRef<(() => Promise<void>) | null>(null);

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

  const reportError = useCallback(
    (e: unknown) => {
      const msg = friendlyMessage(e, GENERIC_COPY);
      if (isTransient(e) || msg === GENERIC_COPY || msg === NETWORK_COPY) {
        console.debug("[openlounge] action failed quietly", e);
        return;
      }
      pushToast({ kind: "plain", message: msg });
    },
    [pushToast],
  );

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
    // Launch: decide signed-in vs signed-out BEFORE any sign-in/onboarding UI renders. With stored credentials
    // the neutral splash stays up while we validate (refreshing silently); only a definitive "session is over"
    // from the server shows the sign-in screen. Offline → keep the splash and retry quietly.
    let disposed = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;
    const boot = async (attempt = 0) => {
      if (disposed || !loadCreds()) return;
      try {
        const v = await validateStoredSession();
        if (disposed) return;
        if (!v) return dropSession();
        if (!meRef.current) applySession(v);
      } catch {
        if (disposed || meRef.current) return; // the socket resume may already have signed us in
        bootTimer = setTimeout(() => void boot(attempt + 1), Math.min(15_000, 1000 * 2 ** attempt));
      }
    };

    const s = new RealtimeClient();
    // Tell the server whether the app is in the foreground (Android WebView backgrounding, hidden tabs)
    const reportVisibility = () => {
      if (!tokenRef.current && !loadToken()) return;
      s.emit("presence:visible", { visible: appVisible() });
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
      if (s.connected && meRef.current && appVisible()) void markSynced();
    }, 60_000);
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    let resumeAttempt = 0;
    type ResumeRes = ({ ok: true } & SessionPayload) | { ok: false; reason?: string };
    // Authenticate this socket with an access token. expired/invalid → one silent refresh + retry;
    // a definitive refusal of the refresh token → sign-in screen (no message); anything else → retry quietly.
    const resumeOnce = async (): Promise<void> => {
      if (!loadCreds()) return;
      for (let pass = 0; pass < 2; pass++) {
        let access: string;
        try {
          access = pass === 0 ? await getAccessToken() : (await refreshSession({ ...loadCreds()!, access: null, accessExp: 0 })).access!;
        } catch (err) {
          if (err instanceof SignedOutError) return dropSession();
          throw err;
        }
        const res = await s.request<ResumeRes>("session:resume", { token: access });
        if (res?.ok) {
          resumeAttempt = 0;
          applySession(res);
          if (!appVisible()) reportVisibility();
          void catchUp();
          return;
        }
        const reason = (res as { reason?: string } | null)?.reason;
        if (reason === "revoked") return dropSession();
        if (reason !== "expired" && reason !== "invalid") break; // older server mid-deploy, odd reply: retry later
      }
      throw new Error("resume");
    };
    let resuming: Promise<void> | null = null;
    const resume = (): Promise<void> => {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = null;
      if (!loadCreds()) return Promise.resolve();
      resuming ??= resumeOnce()
        .catch(() => {
          // offline / timed out / server busy: try again soon while connected (a reconnect also resumes)
          if (!s.connected) return;
          resumeTimer = setTimeout(() => void resume(), Math.min(15_000, 1000 * 2 ** resumeAttempt++));
        })
        .finally(() => {
          resuming = null;
        });
      return resuming;
    };
    resumeRef.current = resume;
    s.on("session:revoked", () => dropSession());
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
    s.on("rooms:update", (list: RoomSummary[]) => {
      setRooms(list);
      setRoomsLoaded(true);
    });
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
    window.addEventListener(NATIVE_VISIBILITY_EVENT, reportVisibility);
    // dm:message notifications (banner / OS notification) live in <Notifier/>
    s.connect();
    setSocket(s);
    // Reconcile the native shell's token store (Android SharedPreferences / iOS Keychain) with web storage first —
    // localStorage may have been evicted or belong to another origin — then decide. Until then: splash.
    void hydrateFromNative().then((c) => {
      if (disposed) return;
      setToken(c?.refresh ?? null);
      setBooted(true);
      if (!c) return;
      void boot();
      if (s.connected && !meRef.current) void resumeRef.current?.();
    });
    return () => {
      disposed = true;
      if (bootTimer) clearTimeout(bootTimer);
      if (resumeTimer) clearTimeout(resumeTimer);
      clearInterval(syncTimer);
      if (offlineTimer) clearTimeout(offlineTimer);
      document.removeEventListener("visibilitychange", reportVisibility);
      window.removeEventListener(NATIVE_VISIBILITY_EVENT, reportVisibility);
      s.removeAllListeners();
      s.close();
    };
  }, [applySession, dropSession, banner]);

  // Socket request with graceful failure: waits briefly for a reconnect instead of failing, re-authenticates
  // silently if the server lost track of us (restart/redeploy), and only ever throws a FriendlyError.
  const request = useCallback(
    async <T,>(event: string, payload?: unknown): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        if (!socket) throw new FriendlyError(NETWORK_COPY, true);
        let res: { ok?: boolean; error?: string; reason?: string } | undefined;
        try {
          res = await socket.request<{ ok?: boolean; error?: string }>(event, payload ?? {});
        } catch (e) {
          // never sent (socket down): wait for the reconnect and send once more
          if (attempt === 0 && (e as Error)?.message === "Not connected" && (await waitConnected(socket, 8_000))) continue;
          throw toFriendly(e);
        }
        if (res && res.ok === false) {
          if (attempt === 0 && res.error === "Not signed in" && loadCreds()) {
            await resumeRef.current?.().catch(() => {});
            continue;
          }
          throw new FriendlyError(friendlyMessage(res.error));
        }
        return res as T;
      }
    },
    [socket],
  );

  const completeLogin = useCallback(
    (t: string, session: SessionPayload & { access?: string; accessExpiresAt?: number }, opts?: { onboarding?: boolean }) => {
      saveCreds({ refresh: t, access: session.access ?? null, accessExp: session.accessExpiresAt ?? 0, uid: session.user?.id ?? null });
      setToken(t);
      applySession(session);
      setOnboarding(!!opts?.onboarding);
    },
    [applySession],
  );

  const finishOnboarding = useCallback(() => setOnboarding(false), []);

  // Settings → Log out: revoke this device's session on the server (POST /auth/logout), detach the socket, clear storage.
  const signOut = useCallback(async () => {
    await logout();
    try {
      await socket?.request("session:logout", {}, 2000);
    } catch {
      /* offline: token is already dropped locally */
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
        // put the button back the way the server has it; no error toast
        setFollowing((prev) => {
          const next = new Set(prev);
          if (f) next.delete(userId);
          else next.add(userId);
          return next;
        });
        reportError(e);
      }
    },
    [request, reportError],
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
      roomsLoaded,
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
      reportError,
      banner,
      dismissToast,
      onlineIds,
      isOnline,
      lastSeenAt,
      presenceOf,
      offline,
    }),
    [status, connected, socket, me, rooms, roomsLoaded, following, toasts, unreadDms, onboarding, setActiveDm, getActiveDm, completeLogin, finishOnboarding, signOut, request, follow, updateMe, setPhoto, toast, reportError, banner, dismissToast, onlineIds, isOnline, lastSeenAt, presenceOf, offline],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
