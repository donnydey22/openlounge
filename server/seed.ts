// Demo seed data: a handful of "notable" bot users, a crowd of filler bots,
// and a few live rooms so the hallway feels alive on first load.

import { AVATAR_COLORS } from "../src/lib/types";

export interface SeedUser {
  id: string;
  name: string;
  bio: string;
  color: string;
  baseFollowers: number;
  baseFollowing: number;
}

export interface SeedRoom {
  id: string;
  title: string;
  topic: string;
  description: string;
  hostId: string;
  speakerIds: string[];
  listenerCount: number;
  ageMinutes: number;
}

export const NOTABLE_USERS: SeedUser[] = [
  { id: "bot-maya", name: "Maya Chen", bio: "Founder @ Loopwave. Building tools for creators. Ex-Spotify. 🎧", color: "#EC4899", baseFollowers: 12400, baseFollowing: 310 },
  { id: "bot-jordan", name: "Jordan Blake", bio: "Product designer. Type nerd. Coffee snob. Figma plugin hoarder.", color: "#3B82F6", baseFollowers: 5230, baseFollowing: 488 },
  { id: "bot-priya", name: "Priya Raman", bio: "ML engineer. Talks about LLMs way too much. Opinions are my own.", color: "#8B5CF6", baseFollowers: 18900, baseFollowing: 220 },
  { id: "bot-marcus", name: "Marcus Hill", bio: "Indie musician & producer. Lo-fi forever. New EP soon.", color: "#F97316", baseFollowers: 7810, baseFollowing: 901 },
  { id: "bot-sofia", name: "Sofia Alvarez", bio: "Meditation teacher, recovering lawyer. Breathe in, breathe out.", color: "#14B8A6", baseFollowers: 3420, baseFollowing: 150 },
  { id: "bot-kenji", name: "Kenji Watanabe", bio: "Game dev. Speedrunner. Shipping a cozy roguelike in 2027. 🎮", color: "#22C55E", baseFollowers: 6100, baseFollowing: 377 },
  { id: "bot-amara", name: "Amara Okafor", bio: "Partner @ Northlight Ventures. Pre-seed & seed. DMs open.", color: "#EAB308", baseFollowers: 22100, baseFollowing: 640 },
  { id: "bot-leo", name: "Leo Fischer", bio: "Writer. Night owl. Collecting stories from strangers.", color: "#06B6D4", baseFollowers: 2890, baseFollowing: 1203 },
  { id: "bot-nia", name: "Nia Thompson", bio: "Sports analyst. Hoops, data, and hot takes.", color: "#EF4444", baseFollowers: 9050, baseFollowing: 412 },
  { id: "bot-omar", name: "Omar Haddad", bio: "Curator & DJ. Making the internet a little weirder.", color: "#84CC16", baseFollowers: 4470, baseFollowing: 820 },
];

const FIRST = ["Ava", "Liam", "Zoe", "Noah", "Ivy", "Eli", "Mia", "Kai", "Luna", "Theo", "Aria", "Milo", "Nora", "Ezra", "Ruby", "Finn", "Lila", "Owen", "Jade", "Ravi", "Sana", "Diego", "Hana", "Tariq", "Elena", "Yusuf", "Chloe", "Mateo", "Iris", "Felix"];
const LAST = ["Park", "Nguyen", "Silva", "Kim", "Patel", "Rossi", "Cohen", "Diaz", "Ito", "Brooks", "Khan", "Novak", "Reyes", "Hart", "Lund", "Moreau", "Ali", "Ward", "Sato", "Costa"];
const FILLER_BIOS = [
  "Just here to listen 👂",
  "Curious about everything.",
  "Night owl. Coffee enthusiast.",
  "Building something new.",
  "Music, books, and long walks.",
  "Learning out loud.",
  "Ex-teacher, now in tech.",
  "Product @ a stealth startup.",
  "Designer by day, DJ by night.",
  "Here for the good conversations.",
];

export function fillerUsers(count = 110): SeedUser[] {
  const users: SeedUser[] = [];
  for (let i = 0; i < count; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length];
    users.push({
      id: `bot-f${i}`,
      name: `${first} ${last}`,
      bio: FILLER_BIOS[i % FILLER_BIOS.length],
      color: AVATAR_COLORS[(i * 3) % AVATAR_COLORS.length],
      baseFollowers: 20 + ((i * 137) % 900),
      baseFollowing: 40 + ((i * 89) % 600),
    });
  }
  return users;
}

export const SEED_ROOMS: SeedRoom[] = [
  {
    id: "ai-features",
    title: "Shipping AI features without the hype 🤖",
    topic: "Tech",
    description: "Real talk on evals, latency, and what actually works in production. Raise your hand to share war stories.",
    hostId: "bot-priya",
    speakerIds: ["bot-jordan"],
    listenerCount: 24,
    ageMinutes: 47,
  },
  {
    id: "lofi-jam",
    title: "Late night lo-fi jam 🎹",
    topic: "Music",
    description: "Chill beats, open mic for producers. Bring a loop.",
    hostId: "bot-marcus",
    speakerIds: ["bot-omar", "bot-leo"],
    listenerCount: 16,
    ageMinutes: 82,
  },
  {
    id: "founder-hot-seat",
    title: "Founders' hot seat: pitch in 60 seconds",
    topic: "Startups",
    description: "Pre-seed founders pitch, investors give live feedback. Hand up to get in the queue.",
    hostId: "bot-amara",
    speakerIds: ["bot-maya"],
    listenerCount: 21,
    ageMinutes: 23,
  },
  {
    id: "breathwork",
    title: "Morning reset: 10-minute breathwork 🌿",
    topic: "Wellness",
    description: "A gentle guided session to start your day. Cameras off, minds on.",
    hostId: "bot-sofia",
    speakerIds: [],
    listenerCount: 11,
    ageMinutes: 8,
  },
  {
    id: "indie-games",
    title: "Indie game devs: what are you building?",
    topic: "Gaming",
    description: "Show & tell for small teams. Share your project, get feedback, find playtesters.",
    hostId: "bot-kenji",
    speakerIds: ["bot-nia"],
    listenerCount: 13,
    ageMinutes: 35,
  },
];

export const BOT_CHAT_LINES = [
  "This is so good 🔥",
  "+1 to that",
  "👏👏👏",
  "Greetings from Lisbon 👋",
  "Hot take but I agree",
  "Raising my hand for this one ✋",
  "What tools are you using for that?",
  "Love this room",
  "Can someone drop the link later?",
  "Taking notes 📝",
  "Couldn't agree more",
  "First time here, loving the vibe",
  "This is the content I'm here for",
  "Wait, can you repeat that last part?",
  "🙌",
  "So true",
  "Saving this convo in my brain forever",
  "Anyone else listening from the car? 🚗",
];

export const BOT_DM_REPLIES = [
  "Haha totally, {name} 😄",
  "Love that idea!",
  "Let's hop in a room about that sometime.",
  "Ooh tell me more",
  "100% agree",
  "Ha, I was literally just thinking about that",
  "Appreciate you, {name} 🙏",
  "Good question — I'd say it depends on the team.",
  "Sending you a follow back 🙂",
  "That's wild. When did that happen?",
];
