"use client";
// In-app ring for group / room calls (server/calls/groupRing.ts): stays up until Join, Decline, the caller cancels,
// someone answers on another device, or it expires (then the server sends the "Missed call").
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, PhoneOff, Video } from "lucide-react";
import { useApp } from "@/components/AppProvider";

type Ring = { id: string; kind: "group" | "room"; roomId: string; video: boolean; expiresAt: number; caller: { id: string; name: string; photoUrl: string | null } };

export function GroupRingBanner() {
  const { socket, request } = useApp();
  const router = useRouter();
  const [ring, setRing] = useState<Ring | null>(null);
  useEffect(() => {
    if (!socket) return;
    const on = (r: Ring) => setRing(r);
    const off = (d: { id: string }) => setRing((cur) => (cur?.id === d.id ? null : cur));
    socket.on("ring:incoming", on);
    socket.on("ring:cancel", off);
    return () => { socket.off("ring:incoming", on); socket.off("ring:cancel", off); };
  }, [socket]);
  useEffect(() => {
    if (!ring) return;
    const t = setTimeout(() => setRing(null), Math.max(0, ring.expiresAt - Date.now()));
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); } catch {}
    return () => clearTimeout(t);
  }, [ring]);
  if (!ring) return null;
  const respond = (answer: boolean) => {
    const r = ring; setRing(null);
    void request<{ ok: boolean; roomId?: string }>("ring:respond", { id: r.id, answer }).then((x) => { if (answer) router.push(`/room/${x.roomId ?? r.roomId}`); }).catch(() => {});
  };
  return (
    <div role="alertdialog" aria-label="Incoming group call" data-testid="group-ring" className="fixed inset-x-3 top-3 z-[100] mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-zinc-900/95 p-4 text-zinc-100 shadow-2xl ring-1 ring-white/10">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{ring.caller.name}</div>
        <div className="text-sm text-zinc-400">{ring.video ? "Video" : "Audio"} {ring.kind === "group" ? "group" : "room"} call…</div>
      </div>
      <button type="button" aria-label="Decline" onClick={() => respond(false)} className="rounded-full bg-red-500 p-3"><PhoneOff className="h-5 w-5" /></button>
      <button type="button" aria-label="Join" onClick={() => respond(true)} className="rounded-full bg-emerald-500 p-3 text-black">{ring.video ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}</button>
    </div>
  );
}
