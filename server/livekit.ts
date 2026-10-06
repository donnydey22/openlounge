// LiveKit (Cloud or self-hosted) integration: join tokens + server-side permission
// changes. Configure with LIVEKIT_URL (wss://<project>.livekit.cloud),
// LIVEKIT_API_KEY and LIVEKIT_API_SECRET. Without them the app still runs —
// rooms/chat/hands work and the UI explains that live audio is off.

import { AccessToken, RoomServiceClient, TrackType } from "livekit-server-sdk";

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

export const livekit = {
  enabled: !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
  url: LIVEKIT_URL ?? "",
};

const svc = livekit.enabled
  ? new RoomServiceClient(LIVEKIT_URL!.replace(/^ws/, "http"), LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

/** One LiveKit room per Open Lounge room. */
export const lkRoomName = (roomId: string) => `openlounge-${roomId}`;

export async function createJoinToken(opts: { roomId: string; userId: string; name: string; canPublish: boolean }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: opts.userId,
    name: opts.name,
    ttl: "2h",
  });
  at.addGrant({
    room: lkRoomName(opts.roomId),
    roomJoin: true,
    canSubscribe: true,
    canPublish: opts.canPublish, // listeners can't publish until the host invites them up
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

const quiet = (label: string) => (err: unknown) => {
  const msg = (err as Error)?.message ?? String(err);
  // "participant not found" is normal when someone hasn't connected audio yet
  if (!/not found|does not exist/i.test(msg)) console.warn(`[livekit] ${label}: ${msg}`);
};

/** Grant/revoke publishing when someone is invited to / removed from the stage. */
export function setCanPublish(roomId: string, userId: string, canPublish: boolean) {
  if (!svc) return;
  svc
    .updateParticipant(lkRoomName(roomId), userId, {
      permission: { canSubscribe: true, canPublish, canPublishData: false },
    })
    .catch(quiet("updateParticipant"));
}

/** Server-side enforcement of a host mute (the client also mutes itself). */
export function muteParticipantAudio(roomId: string, userId: string) {
  if (!svc) return;
  svc
    .getParticipant(lkRoomName(roomId), userId)
    .then((p) =>
      Promise.all(
        p.tracks.filter((t) => t.type === TrackType.AUDIO && !t.muted).map((t) => svc.mutePublishedTrack(lkRoomName(roomId), userId, t.sid, true)),
      ),
    )
    .catch(quiet("mute"));
}

/**
 * Disconnect everyone when the host ends the room. Clients leave on their own when they get
 * `room:ended`; the delayed deleteRoom is the backstop for anyone who doesn't (so ended
 * rooms can't keep carrying audio).
 */
export function closeLiveKitRoom(roomId: string, delayMs = 4000) {
  if (!svc) return;
  const s = svc;
  setTimeout(() => s.deleteRoom(lkRoomName(roomId)).catch(quiet("deleteRoom")), delayMs).unref();
}
