// Open Lounge room links pasted into a DM ("openlounge.app/room/ab12cd34", with or without https://, or this
// deployment's own origin) render as the same live join card as an invite.
import { PUBLIC_ORIGIN } from "./links";

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hosts(): string[] {
  const out = new Set(["openlounge.app", "www.openlounge.app", hostOf(PUBLIC_ORIGIN)]);
  if (typeof window !== "undefined" && window.location?.host) out.add(window.location.host);
  return [...out].filter(Boolean);
}

let cached: { key: string; re: RegExp } | null = null;
function re() {
  const hs = hosts();
  const key = hs.join("|");
  if (cached?.key !== key) cached = { key, re: new RegExp(`(?:https?:\\/\\/)?(?:${hs.map(esc).join("|")})\\/room\\/([\\w-]{1,64})(?![\\w-])`, "gi") };
  return cached.re;
}

/** Room ids linked in a message, in order, deduped (max 3 cards per message). */
export function roomIdsInText(text: string): string[] {
  if (!text || text.indexOf("/room/") < 0) return [];
  const out: string[] = [];
  for (const m of text.matchAll(re())) if (!out.includes(m[1])) out.push(m[1]);
  return out.slice(0, 3);
}
