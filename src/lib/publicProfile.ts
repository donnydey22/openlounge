// Server-side fetch of a public profile card from our own API (same process/port as Next).
export interface PublicCard {
  id: string;
  name: string;
  username: string;
  color: string;
  photoUrl: string | null;
  bio: string;
  followers: number;
  following: number;
}

export async function fetchPublicCard(handle: string): Promise<PublicCard | null> {
  if (!/^[A-Za-z0-9_]{1,30}$/.test(handle)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/users/by-handle/${handle}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return j.ok ? j.user : null;
  } catch {
    return null;
  }
}
