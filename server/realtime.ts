// Realtime wiring over raw WebSockets: auth, rooms, host controls, chat, DMs, follows.
// Audio itself goes through LiveKit (see livekit.ts); this layer keeps LiveKit
// publish permissions in sync with stage roles.

import type { Ack, DirectMessage, Role } from "../src/lib/types";
import type { Conn, WsHub } from "./ws";
import { closeLiveKitRoom, createJoinToken, livekit, muteParticipantAudio, setCanPublish } from "./livekit";
import { store } from "./store";
import { stickers } from "./stickers/service";
import { isGroupId } from "./conversation";
import { attachGroupHandlers, groupHistory, groupMessage, groupTyping, groups, wireGroups } from "./groups";
import { OtpService, normalizePhone } from "./otp";
import { dropTicket, getTicket, issueTicket } from "./authx/signup";
import { ACTIVITY_THROTTLE_MS, PRESENCE_CHANNEL, Presence, type PresenceStatus } from "./presence";
import { deviceLabel } from "./auth";
import type { IncomingMessage } from "node:http";
import { demoOtpEnabled, firebaseConfigured, verifyPhoneIdToken } from "./firebase";
import { bg, push, setForegroundCheck } from "./push";

const TYPING_MIN_GAP_MS = 1_000; // a "typing" ping per peer at most once a second (clients send every ~3s)
const TYPING_MAX_PER_10S = 20; // typing + typing_stop frames per socket per 10s
/** in-chat room cards: live updates per room are coalesced to at most one push per this window */
const CARD_COALESCE_MS = 250;
const CARD_WATCHERS_MAX = 2_000; // per room
const INVITE_MAX_RECIPIENTS = 20; // per room:inviteDm request
const CARDS_MAX_PER_REQUEST = 30;
const ROOM_ID = /^[\w-]{1,64}$/;

/**
 * Firebase Phone Auth: verify the ID token, then the same find-or-create-by-E.164 path as the OTP flow.
 * existing account → new session; unknown number → signup ticket (profile steps follow, then auth:register).
 */
export async function firebasePhoneLogin(idToken: unknown, device: string) {
  const v = await verifyPhoneIdToken(String(idToken ?? ""));
  if (!v.ok) return v;
  const e164 = normalizePhone(v.phone);
  if (!e164) return { ok: false as const, error: "That phone number isn't supported" };
  const existing = store.userByPhone(e164);
  if (existing) return { ok: true as const, status: "existing" as const, userId: existing.id, creds: store.createSession(existing.id, device) };
  // same signup ticket as phone OTP / email / Google / Apple (server/authx/signup.ts) → one onboarding path
  const ticket = issueTicket({ kind: "phone", phone: e164 });
  return { ok: true as const, status: "new" as const, ticket, phone: e164 };
}

type AckFn = (res: Ack<Record<string, unknown>>) => void;
const noop: AckFn = () => {};

export function registerRealtime(io: WsHub) {
  const userOfSocket = new Map<string, string>();
  /** socket -> session id it authenticated with (logout / revocation / "last seen") */
  const sessionOfSocket = new Map<string, string>();
  /** Online presence (multi-tab/device aware, heartbeat + visibility driven). See presence.ts. */
  const presence = new Presence(
    io,
    (connId) => store.roomOfSocket(connId) !== null,
    (sessionId, at) => store.touchSession(sessionId, at),
    store.lastSeenByUser(),
  );
  const withOnline = <T extends { id: string }>(u: T): T & { online: boolean; lastSeenAt: number | null; presence: PresenceStatus } => ({
    ...u,
    online: presence.isOnline(u.id),
    lastSeenAt: presence.lastSeenAt(u.id),
    presence: presence.statusOf(u.id),
  });
  /** pushed DMs carry the sender's current photo so banners / notifications can show it (additive field) */
  const withSenderPhoto = (m: DirectMessage): DirectMessage => ({ ...m, fromPhotoUrl: store.publicUser(m.fromId)?.photoUrl ?? null });
  // generic conversation layer (groups): hooks the store's DM paths for group ids + per-member fan-out
  wireGroups(io, withOnline);
  const otp = new OtpService();
  // a user is "in the foreground" when any of their connections is visible (not a backgrounded WebView / hidden tab)
  setForegroundCheck((userId) => {
    for (const c of io.members(`user:${userId}`)) if (!c.hidden) return true;
    return false;
  });
  const demoOtpOn = demoOtpEnabled();
  console.log(`[auth] SMS provider: ${otp.provider.name}${otp.provider.revealsCodes && demoOtpOn ? " (demo — codes shown on screen, 000000 also works)" : ""}${demoOtpOn ? "" : " (demo OTP disabled; phone sign-in via Firebase)"}`);
  if (demoOtpOn && otp.provider.revealsCodes && process.env.NODE_ENV === "production")
    console.warn("[auth] ⚠️  Demo OTP in production: anyone can sign in as any phone number. Configure a real SMS/OTP provider before sharing this URL publicly.");
  // phone verified but no account yet → a signup ticket (server/authx/signup.ts, shared with email/Google/Apple)
  /** per-socket OTP request budget */
  const otpBudget = new Map<string, number[]>();
  let listTimer: NodeJS.Timeout | null = null;
  const roomTimers = new Map<string, NodeJS.Timeout>();

  // In-chat room cards (invite cards, drop-in cards, pasted room links): users who have a card for a room on screen
  // (or in a DM) get "room:card" pushes with its live state — listeners, speaker faces, Ended — coalesced per room.
  const cardWatchers = new Map<string, Set<string>>();
  const cardTimers = new Map<string, NodeJS.Timeout>();
  const watchCard = (roomId: string, ...userIds: string[]) => {
    if (!store.rooms.has(roomId)) return;
    let set = cardWatchers.get(roomId);
    if (!set) cardWatchers.set(roomId, (set = new Set()));
    for (const u of userIds) if (set.size < CARD_WATCHERS_MAX) set.add(u);
  };
  const pushCards = (roomId: string) => {
    const set = cardWatchers.get(roomId);
    if (!set) return;
    for (const uid of set) io.to(`user:${uid}`).emit("room:card", store.roomCard(roomId, uid));
  };
  const scheduleCards = (roomId: string) => {
    if (!cardWatchers.has(roomId) || cardTimers.has(roomId)) return;
    cardTimers.set(
      roomId,
      setTimeout(() => {
        cardTimers.delete(roomId);
        pushCards(roomId);
      }, CARD_COALESCE_MS),
    );
  };

  // Keep LiveKit permissions in sync with stage roles (and enforce host mutes).
  const lastSeen = new Map<string, Map<string, { role: Role; muted: boolean }>>();
  const syncLiveKit = (roomId: string, participants: { userId: string; role: Role; muted: boolean; isBot: boolean }[]) => {
    if (!livekit.enabled) return;
    const prev = lastSeen.get(roomId) ?? new Map();
    const next = new Map<string, { role: Role; muted: boolean }>();
    for (const p of participants) {
      if (p.isBot) continue;
      next.set(p.userId, { role: p.role, muted: p.muted });
      const before = prev.get(p.userId);
      if (!before) continue; // token issued at join already carries the right permission
      const couldPublish = before.role !== "listener";
      const canPublish = p.role !== "listener";
      if (couldPublish !== canPublish) setCanPublish(roomId, p.userId, canPublish);
      if (canPublish && !before.muted && p.muted) muteParticipantAudio(roomId, p.userId);
    }
    lastSeen.set(roomId, next);
  };

  store.attach({
    roomChanged(roomId) {
      scheduleCards(roomId);
      // coalesce bursts of changes into one broadcast
      if (roomTimers.has(roomId)) return;
      roomTimers.set(
        roomId,
        setTimeout(() => {
          roomTimers.delete(roomId);
          const state = store.roomState(roomId);
          if (!state) return;
          io.to(`room:${roomId}`).emit("room:state", state);
          syncLiveKit(roomId, state.participants);
        }, 60),
      );
    },
    roomsListChanged() {
      if (listTimer) return;
      listTimer = setTimeout(() => {
        listTimer = null;
        io.emit("rooms:update", store.listRooms());
      }, 400);
    },
    roomEnded(roomId) {
      // cards flip to "Ended" right away (no coalescing), then nobody needs updates for this room any more
      clearTimeout(cardTimers.get(roomId));
      cardTimers.delete(roomId);
      pushCards(roomId);
      cardWatchers.delete(roomId);
      io.to(`room:${roomId}`).emit("room:ended", { roomId });
      io.clearChannel(`room:${roomId}`);
      lastSeen.delete(roomId);
      closeLiveKitRoom(roomId);
    },
    toast(userId, message) {
      io.to(`user:${userId}`).emit("toast", { message });
    },
    kickSocket(socketId, roomId, reason) {
      const s = io.get(socketId);
      if (!s) return;
      s.leave(`room:${roomId}`);
      s.emit("room:kicked", { roomId, reason });
    },
    chatMessage(msg) {
      io.to(`room:${msg.roomId}`).emit("chat:message", msg);
    },
    chatDeleted(roomId, messageId) {
      io.to(`room:${roomId}`).emit("chat:deleted", { roomId, messageId });
    },
    roomPresence(ev) {
      io.to(`room:${ev.roomId}`).emit("room:presence", ev);
    },
    roomReaction(reaction) {
      io.to(`room:${reaction.roomId}`).emit("room:reaction", reaction);
    },
    meChanged(userId, user) {
      io.to(`user:${userId}`).emit("me:update", { user });
    },
    sessionRevoked(sessionId) {
      for (const [connId, sid] of [...sessionOfSocket]) {
        if (sid !== sessionId) continue;
        const c = io.get(connId);
        if (c) signOutSocket(c);
        c?.emit("session:revoked", {});
      }
    },
    dmRead(receipt) {
      // the sender's devices flip ✓ → ✓✓; the reader's other devices clear their unread state
      io.to(`user:${receipt.peerId}`).to(`user:${receipt.readerId}`).emit("dm:read-receipt", receipt);
      bg(push()?.dmRead(receipt.readerId, receipt.peerId));
    },
    dmMessage(msg) {
      if (isGroupId(msg.toId)) return groupMessage(msg);
      groups.noteDm(msg);
      // deliver to every tab of both participants (sender's other tabs stay in sync)
      io.to(`user:${msg.toId}`).to(`user:${msg.fromId}`).emit("dm:message", withSenderPhoto(msg));
      io.to(`user:${msg.toId}`).emit("dm:unread", { count: store.unreadDmCount(msg.toId) });
      // room invite / drop-in cards: a "join the room" push (opens the room) instead of a plain DM push
      if (msg.kind && msg.roomId) bg(push()?.roomInviteDm(msg.roomId, store.rooms.get(msg.roomId)?.title ?? "", msg.fromId, msg.toId, msg.kind));
      else bg(push()?.dm(msg));
    },
    dmTyping(fromId, toId) {
      io.to(`user:${toId}`).emit("dm:typing", { from: fromId });
    },
  });

  // Auth re-validation for long-lived sockets: a session that expired (or was revoked by a sibling instance) while
  // the socket stayed open is signed out here; the client gets session:revoked and refreshes / re-authenticates.
  const revalidate = setInterval(() => {
    const now = Date.now();
    for (const [connId, sid] of [...sessionOfSocket]) {
      if (store.sessionActive(sid, now)) continue;
      const c = io.get(connId);
      if (c) {
        signOutSocket(c);
        c.emit("session:revoked", { reason: "expired" });
      }
    }
  }, Number(process.env.WS_REVALIDATE_MS || 60_000));
  revalidate.unref();

  /** Server-side sign-out of one connection (logout / revoked session). */
  const signOutSocket = (socket: Conn) => {
    const userId = userOfSocket.get(socket.id);
    if (userId) {
      const where = store.roomOfSocket(socket.id);
      if (where) store.leave(where.roomId, userId);
      socket.leave(`user:${userId}`);
      socket.leave(PRESENCE_CHANNEL);
      presence.detach(socket.id, 0);
    }
    userOfSocket.delete(socket.id);
    sessionOfSocket.delete(socket.id);
  };

  io.onConnection((socket: Conn, req: IncomingMessage) => {
    const ua = req?.headers?.["user-agent"];
    const me = () => userOfSocket.get(socket.id);
    const authed = (ack: AckFn | undefined, fn: (userId: string) => void) => {
      const userId = me();
      if (!userId) return (ack ?? noop)({ ok: false, error: "Not signed in" });
      fn(userId);
    };

    // any authenticated interaction moves "last seen" forward (throttled; no-op while online)
    socket.onAny = (ev) => {
      const uid = me();
      if (uid && ev !== "presence:visible") presence.activity(uid, Date.now(), ACTIVITY_THROTTLE_MS);
    };

    const signIn = (userId: string, sessionId: string) => {
      const prev = me();
      if (prev && prev !== userId) socket.leave(`user:${prev}`);
      userOfSocket.set(socket.id, userId);
      sessionOfSocket.set(socket.id, sessionId);
      socket.join(`user:${userId}`);
      socket.join(PRESENCE_CHANNEL);
      presence.attach(socket.id, userId, sessionId);
      socket.emit("rooms:update", store.listRooms());
      socket.emit("presence:snapshot", presence.snapshot());
      const user = store.me(userId);
      return {
        user: user ? { ...user, online: true, lastSeenAt: null, presence: "online" as const } : user,
        following: store.followingIds(userId),
        unreadDms: store.unreadDmCount(userId),
      };
    };

    // ----- auth: phone → OTP → (new: profile) → session -----
    socket.on("auth:requestCode", async ({ phone }: { phone: string }, ack: AckFn = noop) => {
      if (!demoOtpEnabled()) return ack({ ok: false, error: "Use phone verification to sign in" });
      const e164 = normalizePhone(phone);
      if (!e164) return ack({ ok: false, error: "Enter a valid phone number" });
      const now = Date.now();
      const recent = (otpBudget.get(socket.id) ?? []).filter((t) => now - t < 10 * 60_000);
      if (recent.length >= 6) return ack({ ok: false, error: "Too many codes requested. Try again in a few minutes." });
      otpBudget.set(socket.id, [...recent, now]);
      const res = await otp.request(e164);
      ack(res.ok ? { ...res, phone: e164 } : res);
    });

    socket.on("auth:verifyCode", ({ phone, code, device }: { phone: string; code: string; device?: string }, ack: AckFn = noop) => {
      const e164 = normalizePhone(phone);
      if (!e164) return ack({ ok: false, error: "Enter a valid phone number" });
      if (!demoOtpEnabled()) return ack({ ok: false, error: "Use phone verification to sign in" });
      const v = otp.verify(e164, code);
      if (!v.ok) return ack(v);
      const existing = store.userByPhone(e164);
      if (existing) {
        const creds = store.createSession(existing.id, deviceLabel(device, ua));
        return ack({ ok: true, status: "existing", ...creds, ...signIn(existing.id, creds.sessionId) });
      }
      const ticket = issueTicket({ kind: "phone", phone: e164 });
      ack({ ok: true, status: "new", ticket });
    });

    socket.on("auth:config", (_: unknown, ack: AckFn = noop) => ack({ ok: true, firebase: firebaseConfigured(), demoOtp: demoOtpEnabled() }));

    // Firebase Phone Auth (web SDK signInWithPhoneNumber → ID token). Same response shape as auth:verifyCode.
    socket.on("auth:verifyFirebase", async ({ idToken, device }: { idToken: string; device?: string }, ack: AckFn = noop) => {
      const r = await firebasePhoneLogin(idToken, deviceLabel(device, ua));
      if (!r.ok) return ack(r);
      if (r.status === "existing") return ack({ ok: true, status: "existing", ...r.creds, ...signIn(r.userId, r.creds.sessionId) });
      ack({ ok: true, status: "new", ticket: r.ticket });
    });

    socket.on("auth:checkUsername", ({ username }: { username: string }, ack: AckFn = noop) =>
      ack({ ok: true, ...store.checkUsername(username, me()) }),
    );

    socket.on(
      "auth:register",
      (
        input: { ticket: string; firstName: string; lastName: string; username: string; bio: string; color: string; interests: string[]; photo?: string | null; device?: string },
        ack: AckFn = noop,
      ) => {
        // same ticket shape for every method: phone OTP, or an email / Google / Apple identity (+ password hash for email)
        const t = getTicket(input?.ticket);
        if (!t) return ack({ ok: false, error: "Your verification expired — please start again." });
        const res =
          t.kind === "phone"
            ? store.createAccount(t.phone, input)
            : store.createAccount(null, input, { identity: t.identity, passwordHash: t.passwordHash ?? null });
        if (!res.ok) return ack(res);
        dropTicket(input.ticket);
        if (input.photo) store.setPhoto(res.user.id, input.photo);
        if (t.kind === "phone") bg(push()?.contactJoined(res.user.id, t.phone));
        const creds = store.createSession(res.user.id, deviceLabel(input.device, ua));
        ack({ ok: true, ...creds, ...signIn(res.user.id, creds.sessionId) });
      },
    );

    // Settings → add a phone number to the signed-in account (code from auth:requestCode). The number becomes a
    // phone identity on THIS account, so phone OTP login lands here afterwards.
    socket.on("account:linkPhone", ({ phone, code }: { phone: string; code: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        // Demo codes must never prove ownership once real phone verification is on: otherwise anyone could
        // attach a stranger's (not yet registered) number and receive their future Firebase sign-in.
        if (!demoOtpEnabled()) return ack({ ok: false, error: "Use phone verification to add a number" });
        const e164 = normalizePhone(phone);
        if (!e164) return ack({ ok: false, error: "Enter a valid phone number" });
        const owner = store.userByPhone(e164);
        if (owner && owner.id !== userId) return ack({ ok: false, error: "That number is already linked to another Open Lounge account." });
        const v = otp.verify(e164, code);
        if (!v.ok) return ack(v);
        const r = store.addIdentity(userId, { provider: "phone", subject: e164, verified: true });
        if (!r.ok) return ack({ ok: false, error: r.error });
        io.to(`user:${userId}`).emit("me:update", { user: store.me(userId) });
        ack({ ok: true, user: store.me(userId) });
      }),
    );

    // Settings → add phone with real verification (Firebase ID token): links the verified number to THIS member.
    socket.on("account:linkPhoneFirebase", ({ idToken }: { idToken: string }, ack: AckFn = noop) =>
      authed(ack, async (userId) => {
        const v = await verifyPhoneIdToken(String(idToken ?? ""));
        if (!v.ok) return ack(v);
        const e164 = normalizePhone(v.phone);
        if (!e164) return ack({ ok: false, error: "That phone number isn't supported" });
        const owner = store.userByPhone(e164);
        if (owner && owner.id !== userId) return ack({ ok: false, error: "That number is already linked to another Open Lounge account." });
        const r = store.addIdentity(userId, { provider: "phone", subject: e164, verified: true });
        if (!r.ok) return ack({ ok: false, error: r.error });
        io.to(`user:${userId}`).emit("me:update", { user: store.me(userId) });
        ack({ ok: true, user: store.me(userId) });
      }),
    );

    // Same validation as GET /auth/validate. Accepts an access token (v2) or, for older clients and bots,
    // a legacy session token. On failure: { ok:false, reason:'expired'|'invalid'|'revoked' } — a v2 client
    // refreshes silently and retries; `error` is kept for clients older than v2.
    socket.on("session:resume", async ({ token }: { token: string }, ack: AckFn = noop) => {
      let r: Awaited<ReturnType<typeof store.authenticate>>;
      try {
        r = await store.authenticate(token);
      } catch {
        // database hiccup: never report "signed out" — drop the socket so the client reconnects and resumes again
        socket.ws.close(1013, "try again");
        return;
      }
      if (!r.ok) return ack({ ok: false, reason: r.reason, error: "Session expired" } as never);
      ack({ ok: true, ...signIn(r.userId, r.sessionId) });
    });

    socket.on("session:logout", ({ all }: { all?: boolean } = {}, ack: AckFn = noop) => {
      const userId = me();
      const sid = sessionOfSocket.get(socket.id);
      signOutSocket(socket);
      store.revokeSession(sid, all && userId ? { allForUser: userId } : {});
      ack({ ok: true });
    });

    // ----- presence -----
    // client heartbeat (lets the app detect half-open sockets after network switches / WebView resume)
    socket.on("ping", (_: unknown, ack: AckFn = noop) => ack({ ok: true, now: Date.now() }));

    // foreground/background from document.visibilitychange (Android WebView backgrounding, hidden tabs)
    socket.on("presence:visible", ({ visible }: { visible?: boolean }, ack: AckFn = noop) => {
      presence.setVisible(socket.id, visible !== false);
      socket.hidden = visible === false;
      store.setSocketVisible(socket.id, visible !== false);
      ack({ ok: true });
    });

    socket.on("onboarding:suggestions", (_: unknown, ack: AckFn = noop) =>
      authed(ack, (userId) => ack({ ok: true, users: store.suggestions(userId).map(withOnline) })),
    );

    socket.on("rooms:list", (_: unknown, ack: AckFn = noop) => ack({ ok: true, rooms: store.listRooms() }));

    socket.on("room:create", (input, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const res = store.createRoom(userId, input ?? {});
        if (res.ok) bg(push()?.roomStarted(res.roomId, store.rooms.get(res.roomId)?.title ?? "", userId));
        ack(res);
      }),
    );

    socket.on("room:join", ({ roomId }: { roomId: string }, ack: AckFn = noop) =>
      authed(ack, async (userId) => {
        // leave channels for any other rooms
        for (const r of socket.rooms) if (r.startsWith("room:") && r !== `room:${roomId}`) socket.leave(r);
        const res = store.join(roomId, userId, socket.id);
        if (!res.ok) {
          const state = store.roomState(roomId);
          return ack({ ok: false, error: state?.ended ? "This room has ended" : res.error });
        }
        socket.join(`room:${roomId}`);
        presence.refresh(userId);
        const rec = store.rooms.get(roomId);
        if (rec && rec.hostId !== userId)
          bg(push()?.roomJoined({ id: rec.id, title: rec.title, hostId: rec.hostId, participantIds: [...rec.participants.keys()] }, userId));
        // the LiveKit join token rides on the ack (saves the /api/livekit/token round trip on the way into a room);
        // the client still falls back to the HTTP endpoint when it's missing or for reconnects
        let lk: { url: string; token: string } | null = null;
        if (livekit.enabled) {
          const role = store.roleOf(roomId, userId);
          if (role)
            lk = await createJoinToken({ roomId, userId, name: store.publicUser(userId)?.name ?? "Member", canPublish: role !== "listener" })
              .then((token) => ({ url: livekit.url, token }))
              .catch(() => null);
        }
        ack({ ok: true, room: store.roomState(roomId), chat: store.chatHistory(roomId), audio: { enabled: livekit.enabled, ...(lk ?? {}) } });
      }),
    );

    socket.on("room:leave", ({ roomId }: { roomId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        socket.leave(`room:${roomId}`);
        if (store.socketOf(roomId, userId) === socket.id) store.leave(roomId, userId);
        presence.refresh(userId);
        ack({ ok: true });
      }),
    );

    socket.on("room:end", ({ roomId }: { roomId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => ack(store.endRoom(roomId, userId))),
    );

    socket.on("hand:set", ({ roomId, raised }: { roomId: string; raised: boolean }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        store.setHand(roomId, userId, !!raised);
        ack({ ok: true });
      }),
    );

    socket.on("self:mute", ({ roomId, muted }: { roomId: string; muted: boolean }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        store.setMuted(roomId, userId, !!muted);
        ack({ ok: true });
      }),
    );


    socket.on("stage:toAudience", ({ roomId, userId: target }: { roomId: string; userId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => ack(store.moveToAudience(roomId, userId, target))),
    );

    socket.on("host:invite", ({ roomId, userId: target }: { roomId: string; userId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const res = store.inviteToSpeak(roomId, userId, target);
        if (res.ok) bg(push()?.inviteToSpeak(roomId, store.rooms.get(roomId)?.title ?? "", userId, target));
        ack(res);
      }),
    );

    // Clubhouse "ping": someone in a room pings a person who follows them (or whom they follow) into it
    socket.on("room:ping", ({ roomId, userId: target }: { roomId: string; userId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        if (!store.roleOf(roomId, userId)) return ack({ ok: false, error: "Join the room first" });
        if (!store.publicUser(target) || target === userId) return ack({ ok: false, error: "User not found" });
        const linked = store.followerIds(userId).includes(target) || store.followingIds(userId).includes(target);
        if (!linked) return ack({ ok: false, error: "You can only ping people you follow or who follow you" });
        if (store.roleOf(roomId, target)) return ack({ ok: false, error: "They're already here" });
        const title = store.rooms.get(roomId)?.title ?? "";
        io.to(`user:${target}`).emit("toast", { message: `👋 ${store.publicUser(userId)?.name} pinged you into “${title}”`, href: `/room/${roomId}` });
        bg(push()?.ping(roomId, title, userId, target));
        ack({ ok: true });
      }),
    );

    socket.on("host:mute", ({ roomId, userId: target }: { roomId: string; userId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => ack(store.hostMute(roomId, userId, target))),
    );

    socket.on("podium:set", ({ roomId, userId: target }: { roomId: string; userId: string | null }, ack: AckFn = noop) =>
      authed(ack, (userId) => ack(store.setPodium(roomId, userId, target ?? null))),
    );

    socket.on("reaction:send", ({ roomId, emoji }: { roomId: string; emoji: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        if (store.socketOf(roomId, userId) !== socket.id) return ack({ ok: false, error: "Join the room to react" });
        ack(store.sendReaction(roomId, userId, emoji));
      }),
    );

    // ----- in-room chat -----
    socket.on("chat:send", ({ roomId, text }: { roomId: string; text: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        if (store.socketOf(roomId, userId) !== socket.id) return ack({ ok: false, error: "Join the room to chat" });
        const stickerErr = stickers().sendError(userId, text); // paid sticker packs: buyers only
        if (stickerErr) return ack({ ok: false, error: stickerErr });
        ack(store.sendChat(roomId, userId, text));
      }),
    );

    socket.on("chat:delete", ({ roomId, messageId }: { roomId: string; messageId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => ack(store.deleteChat(roomId, userId, messageId))),
    );

    // ----- groups + unified inbox (group:*, conv:list) -----
    attachGroupHandlers(socket, authed);

    // ----- direct messages -----
    socket.on("dm:list", (_: unknown, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const conversations = store.conversations(userId).map((c) => ({ ...c, peer: withOnline(c.peer) }));
        ack({ ok: true, conversations, unread: store.unreadDmCount(userId) });
      }),
    );

    socket.on("dm:history", ({ peerId, before }: { peerId: string; before?: number }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        if (isGroupId(peerId)) return ack(groupHistory(userId, peerId, before));
        const peer = store.publicUser(peerId);
        if (!peer) return ack({ ok: false, error: "User not found" });
        ack({ ok: true, peer: withOnline(peer), ...store.dmHistory(userId, peerId, before) });
      }),
    );

    // clientId (optional) is echoed on the stored message so the sender's optimistic bubble is swapped in place
    socket.on("dm:send", ({ to, text, clientId }: { to: string; text: string; clientId?: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        presence.activity(userId);
        const stickerErr = stickers().sendError(userId, text); // paid sticker packs: buyers only
        if (stickerErr) return ack({ ok: false, error: stickerErr });
        ack(store.sendDm(userId, to, text, clientId));
      }),
    );

    // Catch-up after a reconnect: every DM to/from me stored after `after` (ms), oldest first.
    socket.on("dm:since", ({ after }: { after?: number }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const r = store.dmsSince(userId, Number(after) || 0);
        ack({ ok: true, messages: r.messages.map(withSenderPhoto), hasMore: r.hasMore });
      }),
    );

    // The client sends this only while the thread is actually on screen (page visible + thread open).
    // upToMessageId (optional) = newest message the reader has seen; the receipt goes out via events.dmRead.
    socket.on("dm:read", ({ peerId, upToMessageId }: { peerId: string; upToMessageId?: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        if (typeof peerId !== "string" || !peerId) return ack({ ok: false, error: "User not found" });
        const r = store.markDmRead(userId, peerId, upToMessageId);
        // a read receipt proves activity: "last seen" must never be older than the "Seen 10:49" it produced
        const readAt = (r.receipt as { readAt?: number } | null | undefined)?.readAt;
        presence.activity(userId, typeof readAt === "number" ? readAt : Date.now());
        if (r.changed) io.to(`user:${userId}`).emit("dm:unread", { count: store.unreadDmCount(userId) });
        ack({ ok: true, receipt: r.receipt });
      }),
    );

    // Typing indicators: ephemeral relay only (never stored). Delivered to the peer's devices only when the
    // peer exists and neither side blocked the other; rate-limited per socket on top of the frame bucket.
    const typingWindow: number[] = [];
    const lastTypingTo = new Map<string, number>();
    const relayTyping = (to: unknown, ev: "dm:typing" | "dm:typing_stop") => {
      const userId = me();
      if (!userId || typeof to !== "string" || !to || to === userId) return;
      const now = Date.now();
      while (typingWindow.length && now - typingWindow[0] > 10_000) typingWindow.shift();
      if (typingWindow.length >= TYPING_MAX_PER_10S) return; // drop silently
      if (ev === "dm:typing" && now - (lastTypingTo.get(to) ?? 0) < TYPING_MIN_GAP_MS) return;
      if (isGroupId(to)) {
        typingWindow.push(now);
        return groupTyping(userId, to, ev);
      }
      if (!store.publicUser(to) || store.isBlockedEither(userId, to)) return;
      typingWindow.push(now);
      if (ev === "dm:typing") lastTypingTo.set(to, now);
      else lastTypingTo.delete(to);
      if (lastTypingTo.size > 50) lastTypingTo.clear();
      io.to(`user:${to}`).emit(ev, { from: userId });
    };
    socket.on("dm:typing", (d: { to: string }) => relayTyping(d?.to, "dm:typing"));
    socket.on("dm:typing_stop", (d: { to: string }) => relayTyping(d?.to, "dm:typing_stop"));

    // ----- audio rooms in DMs -----
    // Invite DM contacts to a live room: one rich invite card per recipient (blocks + rate limits in the store).
    socket.on("room:inviteDm", ({ roomId, to }: { roomId: string; to?: string[] }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const ids = [...new Set((Array.isArray(to) ? to : []).filter((x) => typeof x === "string" && ROOM_ID.test(x)))];
        if (!ids.length) return ack({ ok: false, error: "Pick someone to invite" });
        if (ids.length > INVITE_MAX_RECIPIENTS) return ack({ ok: false, error: `Invite up to ${INVITE_MAX_RECIPIENTS} people at a time` });
        const results: { to: string; ok: boolean; error?: string; messageId?: string }[] = [];
        for (const target of ids) {
          const r = store.sendRoomInvite(userId, target, roomId);
          results.push(r.ok ? { to: target, ok: true, messageId: r.message.id } : { to: target, ok: false, error: r.error });
          if (r.ok) watchCard(roomId, userId, target);
        }
        const sent = results.filter((r) => r.ok).length;
        if (!sent) return ack({ ok: false, error: results[0]?.error ?? "Couldn't send the invite", results } as never);
        presence.activity(userId);
        ack({ ok: true, sent, results, card: store.roomCard(roomId, userId) });
      }),
    );

    // Drop-in audio chat from a DM: a private room only the two of you can join, announced with a card in the DM.
    socket.on("dropin:start", ({ peerId }: { peerId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const r = store.startDropIn(userId, peerId);
        if (!r.ok) return ack(r);
        watchCard(r.roomId, userId, peerId);
        presence.activity(userId);
        ack({ ok: true, roomId: r.roomId, message: r.message, reused: r.reused, card: store.roomCard(r.roomId, userId) });
      }),
    );

    // Live state for the cards on screen (invite cards + pasted openlounge.app/room links); subscribes this user to
    // "room:card" updates for rooms that are still open. Unknown rooms come back as ended.
    socket.on("room:cards", ({ roomIds }: { roomIds?: string[] }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const ids = [...new Set((Array.isArray(roomIds) ? roomIds : []).filter((x) => typeof x === "string" && ROOM_ID.test(x)))].slice(0, CARDS_MAX_PER_REQUEST);
        const cards = ids.map((id) => {
          const c = store.roomCard(id, userId);
          if (!c.ended) watchCard(id, userId);
          return c;
        });
        // the LiveKit origin lets a visible card pre-connect (DNS + TLS) before the tap on Join
        ack({ ok: true, cards, audioUrl: livekit.enabled ? livekit.url : null });
      }),
    );

    // The live room I'm in right now (DM "+" → "Invite to the room you're in").
    socket.on("room:current", (_: unknown, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const roomId = store.currentRoomOf(userId);
        ack({ ok: true, card: roomId ? store.roomCard(roomId, userId) : null });
      }),
    );

    // ----- users & follows -----
    socket.on("user:get", ({ userId }: { userId: string }, ack: AckFn = noop) => {
      const profile = store.profile(userId);
      if (!profile) return ack({ ok: false, error: "User not found" });
      ack({
        ok: true,
        profile: {
          ...profile,
          user: withOnline(profile.user),
          followers: profile.followers.map(withOnline),
          following: profile.following.map(withOnline),
        },
      });
    });

    socket.on("users:list", (_: unknown, ack: AckFn = noop) =>
      ack({ ok: true, users: store.listUsers().map(withOnline) }),
    );

    socket.on("user:follow", ({ userId: target, follow }: { userId: string; follow: boolean }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        if (!store.setFollow(userId, target, !!follow)) return ack({ ok: false, error: "Can't follow that user" });
        if (follow) {
          const name = store.publicUser(userId)?.name;
          io.to(`user:${target}`).emit("toast", { message: `👋 ${name} started following you` });
          bg(push()?.newFollower(target, userId));
        }
        // keep all of this user's tabs in sync
        io.to(`user:${userId}`).emit("follows:update", { following: store.followingIds(userId) });
        ack({ ok: true, following: store.followingIds(userId) });
      }),
    );

    socket.on("user:update", (patch: { name?: string; bio?: string; color?: string; username?: string; interests?: string[] }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const res = store.updateUser(userId, patch ?? {});
        if (!res.ok) return ack(res);
        io.to(`user:${userId}`).emit("me:update", { user: res.user });
        ack(res);
      }),
    );

    socket.on("user:photo", ({ photo }: { photo: string | null }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const res = store.setPhoto(userId, photo);
        if (!res.ok) return ack(res);
        const user = store.me(userId);
        io.to(`user:${userId}`).emit("me:update", { user });
        ack({ ok: true, user });
      }),
    );

    socket.onClose(() => {
      // a socket that was mid-typing went away: tell those peers right away instead of waiting for their 6s TTL
      const userId = me();
      if (userId) for (const to of lastTypingTo.keys()) io.to(`user:${to}`).emit("dm:typing_stop", { from: userId });
      lastTypingTo.clear();
      userOfSocket.delete(socket.id);
      sessionOfSocket.delete(socket.id);
      otpBudget.delete(socket.id);
      store.forgetSocket(socket.id);
      if (!userId) return;
      presence.detach(socket.id);
      const where = store.roomOfSocket(socket.id);
      if (where) store.markAway(where.roomId, userId, socket.id);
    });
  });
}
