// Realtime wiring over raw WebSockets: auth, rooms, host controls, chat, DMs, follows.
// Audio itself goes through LiveKit (see livekit.ts); this layer keeps LiveKit
// publish permissions in sync with stage roles.

import type { Ack, DirectMessage, Role } from "../src/lib/types";
import type { Conn, WsHub } from "./ws";
import { closeLiveKitRoom, livekit, muteParticipantAudio, setCanPublish } from "./livekit";
import { store } from "./store";
import { OtpService, normalizePhone } from "./otp";
import { randomBytes } from "node:crypto";
import { PRESENCE_CHANNEL, Presence, type PresenceStatus } from "./presence";
import { deviceLabel } from "./auth";
import type { IncomingMessage } from "node:http";

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
  const otp = new OtpService();
  console.log(`[auth] SMS provider: ${otp.provider.name}${otp.provider.revealsCodes ? " (demo — codes shown on screen, 000000 also works)" : ""}`);
  if (otp.provider.revealsCodes && process.env.NODE_ENV === "production")
    console.warn("[auth] ⚠️  Demo OTP in production: anyone can sign in as any phone number. Set SMS_PROVIDER=twilio before sharing this URL publicly.");
  /** phone verified but no account yet: ticket -> { phone, expiresAt } */
  const signupTickets = new Map<string, { phone: string; expiresAt: number }>();
  /** per-socket OTP request budget */
  const otpBudget = new Map<string, number[]>();
  let listTimer: NodeJS.Timeout | null = null;
  const roomTimers = new Map<string, NodeJS.Timeout>();

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
    sessionRevoked(sessionId) {
      for (const [connId, sid] of [...sessionOfSocket]) {
        if (sid !== sessionId) continue;
        const c = io.get(connId);
        if (c) signOutSocket(c);
        c?.emit("session:revoked", {});
      }
    },
    dmMessage(msg) {
      // deliver to every tab of both participants (sender's other tabs stay in sync)
      io.to(`user:${msg.toId}`).to(`user:${msg.fromId}`).emit("dm:message", withSenderPhoto(msg));
      io.to(`user:${msg.toId}`).emit("dm:unread", { count: store.unreadDmCount(msg.toId) });
    },
    dmTyping(fromId, toId) {
      io.to(`user:${toId}`).emit("dm:typing", { from: fromId });
    },
  });

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
      const v = otp.verify(e164, code);
      if (!v.ok) return ack(v);
      const existing = store.userByPhone(e164);
      if (existing) {
        const creds = store.createSession(existing.id, deviceLabel(device, ua));
        return ack({ ok: true, status: "existing", ...creds, ...signIn(existing.id, creds.sessionId) });
      }
      const ticket = randomBytes(24).toString("base64url");
      signupTickets.set(ticket, { phone: e164, expiresAt: Date.now() + 30 * 60_000 });
      ack({ ok: true, status: "new", ticket });
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
        const t = signupTickets.get(input?.ticket);
        if (!t || t.expiresAt < Date.now()) return ack({ ok: false, error: "Your verification expired — please start again." });
        const res = store.createAccount(t.phone, input);
        if (!res.ok) return ack(res);
        signupTickets.delete(input.ticket);
        if (input.photo) store.setPhoto(res.user.id, input.photo);
        const creds = store.createSession(res.user.id, deviceLabel(input.device, ua));
        ack({ ok: true, ...creds, ...signIn(res.user.id, creds.sessionId) });
      },
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
      authed(ack, (userId) => ack(store.createRoom(userId, input ?? {}))),
    );

    socket.on("room:join", ({ roomId }: { roomId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        // leave channels for any other rooms
        for (const r of socket.rooms) if (r.startsWith("room:") && r !== `room:${roomId}`) socket.leave(r);
        const res = store.join(roomId, userId, socket.id);
        if (!res.ok) {
          const state = store.roomState(roomId);
          return ack({ ok: false, error: state?.ended ? "This room has ended" : res.error });
        }
        socket.join(`room:${roomId}`);
        presence.refresh(userId);
        ack({ ok: true, room: store.roomState(roomId), chat: store.chatHistory(roomId), audio: { enabled: livekit.enabled } });
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
      authed(ack, (userId) => ack(store.inviteToSpeak(roomId, userId, target))),
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
        ack(store.sendChat(roomId, userId, text));
      }),
    );

    socket.on("chat:delete", ({ roomId, messageId }: { roomId: string; messageId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => ack(store.deleteChat(roomId, userId, messageId))),
    );

    // ----- direct messages -----
    socket.on("dm:list", (_: unknown, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const conversations = store.conversations(userId).map((c) => ({ ...c, peer: withOnline(c.peer) }));
        ack({ ok: true, conversations, unread: store.unreadDmCount(userId) });
      }),
    );

    socket.on("dm:history", ({ peerId, before }: { peerId: string; before?: number }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const peer = store.publicUser(peerId);
        if (!peer) return ack({ ok: false, error: "User not found" });
        ack({ ok: true, peer: withOnline(peer), ...store.dmHistory(userId, peerId, before) });
      }),
    );

    // clientId (optional) is echoed on the stored message so the sender's optimistic bubble is swapped in place
    socket.on("dm:send", ({ to, text, clientId }: { to: string; text: string; clientId?: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => ack(store.sendDm(userId, to, text, clientId))),
    );

    // Catch-up after a reconnect: every DM to/from me stored after `after` (ms), oldest first.
    socket.on("dm:since", ({ after }: { after?: number }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        const r = store.dmsSince(userId, Number(after) || 0);
        ack({ ok: true, messages: r.messages.map(withSenderPhoto), hasMore: r.hasMore });
      }),
    );

    socket.on("dm:read", ({ peerId }: { peerId: string }, ack: AckFn = noop) =>
      authed(ack, (userId) => {
        if (store.markDmRead(userId, peerId)) {
          io.to(`user:${userId}`).emit("dm:unread", { count: store.unreadDmCount(userId) });
        }
        ack({ ok: true });
      }),
    );

    socket.on("dm:typing", ({ to }: { to: string }) => {
      const userId = me();
      if (userId && to && to !== userId) io.to(`user:${to}`).emit("dm:typing", { from: userId });
    });

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
      const userId = me();
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
