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
  isBot: boolean;
  createdAt: number;
  followers: number;
  following: number;
  /** Present when the server knows realtime presence */
  online?: boolean;
}

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
}

export interface ConversationSummary {
  peer: PublicUser;
  lastMessage: DirectMessage;
  unread: number;
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
