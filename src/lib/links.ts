export const PUBLIC_ORIGIN = process.env.NEXT_PUBLIC_PUBLIC_ORIGIN || "https://openlounge.app";
export const profileLink = (username: string) => `${PUBLIC_ORIGIN}/@${username}`;
export const inviteText = (name?: string) => `${name ? `${name.split(" ")[0]} invited you to` : "Join me on"} Open Lounge — live audio rooms with friends 🎙️`;

const KEY = "openlounge:invitesShared";
export function invitesShared(): number {
  try {
    return Number(localStorage.getItem(KEY) || 0) || 0;
  } catch {
    return 0;
  }
}
export function bumpInvitesShared() {
  try {
    localStorage.setItem(KEY, String(invitesShared() + 1));
  } catch {}
}
