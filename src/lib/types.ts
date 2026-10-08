import type { MediaAttachment } from "./media/types";
// Shared types between the WebSocket server (server/) and the Next.js client (src/).

export type Role = "host" | "speaker" | "listener";

export interface PublicUser {
  id: string;
  name: string;
  /** unique @handle (without the @) */
  username: string;
  color: string;
  /** uploaded profile photo URL (served by the app server), null = colored initials */
  photoUrl: string | null;
  interests: string[];
  bio: string;
  /** canonical https URLs keyed by network; empty object = none */
  socialLinks?: import("./socialLinks").SocialLinks;
  isBot: boolean;
  createdAt: number;
  followers: number;
  following: number;
  /** Present when the server knows realtime presence */
  online?: boolean;
  /** When the user was last active in the app (null while online / never seen) */
  lastSeenAt?: number | null;
  /** Live app presence: "online" = app open in the foreground, "away" = connected but backgrounded, "offline" = gone */
  presence?: PresenceStatus;
  /** the account was deleted: render as "Deleted Account" with a ghost avatar (src/lib/userDisplay.ts) */
  deleted?: boolean;
}

/** App-wide presence (presence:update / presence:snapshot): green / amber / no dot */
export type PresenceStatus = "online" | "away" | "offline";

export interface Participant {
  userId: string;
  name: string;
  color: string;
  photoUrl: string | null;
  role: Role;
  muted: boolean;
  handRaised: boolean;
  handRaisedAt: number | null;
  speaking: boolean;
  isBot: boolean;
  joinedAt: number;
  /** Temporarily disconnected (e.g. page refresh). Removed after a short grace period. */
  away: boolean;
  /**
   * Live in-room presence dot: "online" = connected with the app in the foreground,
   * "away" = app backgrounded, or the connection dropped and the seat is being held.
   * (Absent on servers older than this field.)
   */
  presence?: "online" | "away";
}

export interface RoomState {
  id: string;
  title: string;
  topic: string;
  description: string;
  hostId: string;
  createdAt: number;
  ended: boolean;
  seeded: boolean;
  /** User currently holding speaking priority on stage (null = none). */
  podiumUserId: string | null;
  participants: Participant[];
  /** invite-only room (drop-in audio chats): hidden from the hallway, only invited people can join */
  private?: boolean;
  /** Clubhouse-style drop-in audio chat started from a DM (private, ends as soon as it's empty) */
  dropin?: boolean;
  /** drop-ins: invited people who haven't joined yet */
  invited?: { id: string; name: string; color: string; photoUrl: string | null }[];
}

export interface RoomSummary {
  id: string;
  title: string;
  topic: string;
  description: string;
  hostId: string;
  hostName: string;
  createdAt: number;
  seeded: boolean;
  speakerCount: number;
  listenerCount: number;
  speakers: { id: string; name: string; color: string; photoUrl: string | null }[];
}

export interface UserProfile {
  user: PublicUser;
  followers: PublicUser[];
  following: PublicUser[];
  /** Room the user is currently in (if any) */
  currentRoom: { id: string; title: string } | null;
}

export type Ack<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };


export const TOPICS = [
  "Tech",
  "Startups",
  "Music",
  "Wellness",
  "Culture",
  "Design",
  "Gaming",
  "Sports",
  "Other",
] as const;

export const AVATAR_COLORS = [
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#14B8A6",
  "#06B6D4",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#EF4444",
  "#84CC16",
] as const;

// ---------- chat ----------

export const CHAT_MAX_LENGTH = 500;
export const ROOM_CHAT_HISTORY = 200;

export interface ChatMessage {
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  authorPhotoUrl: string | null;
  /** Author's role in the room at the moment they sent the message */
  authorRole: Role;
  authorIsBot: boolean;
  text: string;
  createdAt: number;
}

export interface DirectMessage {
  id: string;
  fromId: string;
  /** Sender's name / avatar color at send time (handy for notifications) */
  fromName: string;
  fromColor: string;
  toId: string;
  text: string;
  createdAt: number;
  /** When the recipient saw it (read receipt, epoch ms); null/absent = sent, not seen yet */
  readAt?: number | null;
  /** Sender's photo (on pushed / catch-up messages; not stored) */
  fromPhotoUrl?: string | null;
  /** Sender-generated id echoed back so an optimistic bubble is replaced in place (no flicker / duplicate) */
  clientId?: string;
  /** Rich message kind: a live audio room invite card, a drop-in audio chat, or a call service message (absent = plain text) */
  kind?: MessageKind;
  /** room the invite card points at (kind set; "call-<id>" for call messages) */
  roomId?: string;
  /** call service message details (kind = "call") */
  call?: CallMeta;
  /** Emoji reactions, oldest first (one per person per message, Telegram-style). Absent = none. */
  reactions?: DmReaction[];
  /** Photo / video / document / voice note (server/media). `text` is then the caption, or a label like "📷 Photo". */
  media?: MediaAttachment;
  /**
   * Album (2–10 photos/videos in one message), in order. `media` then mirrors the first live item so older clients,
   * reply quotes and previews still show a cover. Absent for single attachments.
   */
  attachments?: MediaAttachment[];
  /** Last edit (epoch ms) and how many times it was edited (message editing). Absent = never edited. */
  editedAt?: number;
  editCount?: number;
}

/** Authors can edit their text messages this long after sending (Telegram: 48 h). */
export const MESSAGE_EDIT_WINDOW_MS = 48 * 3_600_000;

/** WS `message_edited`: a 1:1 or group message's text changed. conversationId = the chat as the receiver sees it. */
export interface MessageEditedEvent {
  conversationId: string;
  messageId: string;
  text: string;
  editedAt: number;
  editCount: number;
  by: string;
}

/** Outcome of a 1:1 call as recorded in the DM ("Outgoing call · 3:12", "Missed call", …). */
export type CallOutcome = "completed" | "missed" | "declined" | "cancelled" | "busy" | "failed";
export interface CallMeta {
  id: string;
  callerId: string;
  video: boolean;
  outcome: CallOutcome;
  durationSec: number;
}

export const DM_KINDS = ["room_invite", "dropin"] as const;
export type DmKind = (typeof DM_KINDS)[number];
export type MessageKind = DmKind | "call";

/** A call as the client sees it (call:incoming / call:start / call:get). */
export interface CallPeer {
  id: string;
  name: string;
  username?: string;
  color: string;
  photoUrl: string | null;
}
export type CallPhase = "calling" | "ringing" | "active" | "ended";
export interface CallInfo {
  id: string;
  callerId: string;
  calleeId: string;
  video: boolean;
  phase: CallPhase;
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  outcome: CallOutcome | null;
  /** ring deadline (epoch ms) */
  expiresAt: number;
  caller: CallPeer;
  callee: CallPeer;
  /** active call: participants currently without a connection (inside the reconnect grace) */
  offline?: string[];
}
/** What a participant needs to connect media: LiveKit URL + token (pre-created at ring time). */
export interface CallMedia {
  url: string;
  token: string;
}

/**
 * Live state of an audio room as shown on an in-chat invite / link card ("room:card" events, "room:cards" request).
 * Computed per viewer (canJoin). Unknown / cleaned-up rooms come back as { ended: true }.
 */
export interface RoomCard {
  roomId: string;
  title: string;
  topic: string;
  ended: boolean;
  private: boolean;
  dropin: boolean;
  /** can this viewer join (public room, or invited to a private one) */
  canJoin: boolean;
  createdAt: number | null;
  hosts: { id: string; name: string; color: string; photoUrl: string | null }[];
  speakers: { id: string; name: string; color: string; photoUrl: string | null }[];
  speakerCount: number;
  listenerCount: number;
}

/** One person's reaction on a DM ("dm:reaction_add" / "dm:reaction_remove"; table dm_reactions). */
export interface DmReaction {
  emoji: string;
  userId: string;
  at: number;
}

/** Pushed to both participants when a reaction is added or removed. */
export interface DmReactionEvent {
  messageId: string;
  /** the two participants of the conversation */
  fromId: string;
  toId: string;
  userId: string;
  emoji: string;
  at: number;
}

/** Most distinct emoji one message can collect (keeps the chip row sane). */
export const DM_REACTION_MAX_EMOJI = 12;

export interface ConversationSummary {
  peer: PublicUser;
  lastMessage: DirectMessage;
  unread: number;
  /** pinned to the top of my inbox (absent = not pinned) */
  pinnedAt?: number;
}

/** "dm:chat-state" — my inbox state for a 1:1 chat changed (pin / remove), pushed to all my devices */
export interface ChatStateEvent {
  peerId: string;
  pinned: boolean;
  hidden: boolean;
}

/**
 * "dm:read-receipt" — pushed to both participants' user rooms when `readerId` has seen the conversation with
 * `peerId` (the sender of the messages that were read) up to and including `upToMessageId`.
 */
export interface DmReadReceipt {
  peerId: string;
  readerId: string;
  upToMessageId: string;
  readAt: number;
}

// ---------- auth ----------

export const INTERESTS = [
  // Original Open Lounge taxonomy (multi-select chips — not a Clubhouse copy)
  "🔊 Drop-in talks",
  "🛠️ Builders & makers",
  "🧪 Experiments",
  "📡 Future of work",
  "🧩 Product craft",
  "🎛️ Sound & production",
  "🖼️ Visual arts",
  "📖 Long reads",
  "🏃 Body & movement",
  "☕ Slow mornings",
  "🌙 Late-night chats",
  "🗺️ Places & travel",
  "🍜 Comfort food",
  "🕹️ Play & games",
  "📈 Markets & money",
  "🌱 Living lighter",
  "🎓 Learning in public",
  "🤝 Community building",
  "🎬 Stories on screen",
  "🧠 Deep focus",
  "🐕 Creatures & pets",
  "🎭 Stage & performance",
  "🧭 Career pivots",
  "💡 Side projects",
] as const;

/** Most interests a user can pick (UI counter + server cap in store.cleanInterests). */
export const MAX_INTERESTS = 12;

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/** The signed-in user's own account (includes private fields). */
export interface Me extends PublicUser {
  phoneMasked: string | null;
}

// ---------- room reactions & podium ----------

/** Emoji reactions members can send in a live room (wave + common Clubhouse-ish set). */
export const ROOM_REACTIONS = ["👋", "👏", "❤️", "🔥", "😂", "🙌", "✨", "🎉", "💯", "😮"] as const;
export type RoomReactionEmoji = (typeof ROOM_REACTIONS)[number];

export interface RoomReaction {
  id: string;
  roomId: string;
  userId: string;
  name: string;
  color: string;
  photoUrl: string | null;
  emoji: string;
  createdAt: number;
}

export interface RoomPresenceEvent {
  roomId: string;
  type: "join" | "leave";
  userId: string;
  name: string;
  color: string;
  photoUrl: string | null;
  at: number;
}

/** Per-user push notification settings (server: server/push/prefs.ts) */
export interface NotifPrefsClient {
  dm: boolean;
  roomInvite: boolean;
  followedRoom: boolean;
  trendingRoom: boolean;
  scheduledRoom: boolean;
  recentRoom: boolean;
  newFollower: boolean;
  contactJoined: boolean;
  contactsOptIn: boolean;
  /** "Tell me when contacts join": keep codes of contacts who aren't members yet (no 24 h purge) */
  contactsKeep?: boolean;
  quietHours: { start: string; end: string; tz: string } | null;
}

/** In-app copy of a people / live-activity notification (server "notify:activity", see server/push/notifier.ts) */
export interface ActivityNotice {
  type: string;
  title: string;
  body: string;
  url: string;
  tag: string;
  roomId?: string;
  actor: { id: string; name: string; color: string; photoUrl: string | null } | null;
  at: number;
}
