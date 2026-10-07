import { ImageResponse } from "next/og";
import { fetchPublicCard } from "@/lib/publicProfile";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Open Lounge profile";

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const u = await fetchPublicCard(handle);
  const name = u?.name ?? "Open Lounge";
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", background: "#f4f3ee", padding: 80, fontFamily: "sans-serif" }}>
        <div style={{ width: 260, height: 260, borderRadius: 96, background: u?.color ?? "#10b981", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 110, fontWeight: 700 }}>
          {initials}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 64, maxWidth: 720 }}>
          <div style={{ fontSize: 30, color: "#71717a" }}>🎙️ Open Lounge</div>
          <div style={{ fontSize: 72, fontWeight: 700, color: "#0b0b0d", marginTop: 12 }}>{name}</div>
          {u && <div style={{ fontSize: 36, color: "#52525b" }}>{`@${u.username}`}</div>}
          {u?.bio ? <div style={{ fontSize: 30, color: "#3f3f46", marginTop: 20 }}>{u.bio.slice(0, 110)}</div> : null}
        </div>
      </div>
    ),
    size,
  );
}
