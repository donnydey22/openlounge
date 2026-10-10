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

export type Ack<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string; reason?: string };


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

/** Immutable, server-generated snapshot shown above a reply. It never exposes arbitrary client HTML. */
export interface MessageReply {
  id: string;
  authorName: string;
  text: string;
}

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
  /** Original message context captured by the server at send time. */
  replyTo?: MessageReply;
  /** Server timestamp set only when the author changes message text. */
  editedAt?: number;
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
  /** Original message context captured by the server at send time. */
  replyTo?: MessageReply;
  /** Server timestamp set only when the sender changes message text. */
  editedAt?: number;
  /** When the recipient saw it (read receipt, epoch ms); null/absent = sent, not seen yet */
  readAt?: number | null;
  /** Sender's photo (on pushed / catch-up messages; not stored) */
  fromPhotoUrl?: string | null;
  /** Sender-generated id echoed back so an optimistic bubble is replaced in place (no flicker / duplicate) */
  clientId?: string;
}

export interface ConversationSummary {
  peer: PublicUser;
  lastMessage: DirectMessage;
  unread: number;
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
  quietHours: { start: string; end: string; tz: string } | null;
}
