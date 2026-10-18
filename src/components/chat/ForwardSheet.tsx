"use client";
// Telegram-style forwarding: pick up to 10 chats (1:1 inboxes and groups) from the inbox and forward one message.
// The server re-sends through the normal paths (POST /api/media/forward, server/forward.ts).
import { useEffect, useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import type { InboxItem } from "@/lib/groups";
import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useApp } from "../AppProvider";
import { Avatar } from "../Avatar";
import { Sheet } from "../Sheet";

export const FORWARD_MAX = 10;

export async function forwardMessage(chatId: string, messageId: string, to: string[]) {
  const res = await authFetch("/api/media/forward", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, messageId, to }) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; results?: { to: string; ok: boolean; error?: string }[] };
  return { ok: !!j.ok, error: j.error, results: j.results ?? [] };
}

type Row = { id: string; name: string; color: string; photo: string | null; group: boolean };

export function ForwardSheet({ open, chatId, messageId, onClose, onDone }: { open: boolean; chatId: string; messageId: string | null; onClose: () => void; onDone: (msg: string) => void }) {
  const { request } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setQ("");
    request<{ items: InboxItem[] }>("conv:list")
      .then((r) =>
        setRows(
          r.items.map((x) =>
            x.type === "dm"
              ? { id: x.peer.id, name: x.peer.name, color: x.peer.color, photo: x.peer.photoUrl, group: false }
              : { id: x.id, name: x.group.title, color: x.group.color, photo: x.group.photoUrl, group: true },
          ),
        ),
      )
      .catch(() => setRows([]));
  }, [open, request]);
  const shown = useMemo(() => (rows ?? []).filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())), [rows, q]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= FORWARD_MAX ? p : [...p, id]));
  const send = async () => {
    if (!messageId || !picked.length || busy) return;
    setBusy(true);
    const r = await forwardMessage(chatId, messageId, picked).catch(() => ({ ok: false, error: "Couldn't forward", results: [] }));
    setBusy(false);
    const okN = r.results.filter((x) => x.ok).length;
    const fail = r.results.find((x) => !x.ok)?.error ?? r.error;
    onDone(okN === picked.length ? `Forwarded to ${okN} chat${okN === 1 ? "" : "s"}` : okN ? `Forwarded to ${okN} of ${picked.length}. ${fail ?? ""}`.trim() : fail ?? "Couldn't forward");
    if (okN) onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Forward to…"
      footer={
        <button onClick={send} disabled={!picked.length || busy} data-testid="forward-send" className="h-11 w-full rounded-full bg-emerald-500 text-sm font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40">
          {busy ? "Forwarding…" : picked.length ? `Forward to ${picked.length}` : "Pick chats"}
        </button>
      }
    >
      <label className="mb-2 flex items-center gap-2 rounded-full bg-white/5 px-3">
        <Search className="h-4 w-4 text-zinc-500" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" className="h-10 flex-1 bg-transparent text-sm outline-none" data-testid="forward-search" />
      </label>
      <div className="max-h-[50dvh] overflow-y-auto" data-testid="forward-list">
        {rows === null && <p className="py-6 text-center text-sm text-zinc-500">Loading…</p>}
        {rows && !shown.length && <p className="py-6 text-center text-sm text-zinc-500">No chats</p>}
        {shown.map((r) => {
          const on = picked.includes(r.id);
          return (
            <button key={r.id} type="button" onClick={() => toggle(r.id)} data-testid="forward-row" className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/5">
              <Avatar name={r.name} color={r.color} photo={r.photo} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{r.name}{r.group && <span className="ml-1 text-xs text-zinc-500">group</span>}</span>
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", on ? "border-emerald-400 bg-emerald-500 text-white" : "border-white/25")}>{on && <Check className="h-3.5 w-3.5" />}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
