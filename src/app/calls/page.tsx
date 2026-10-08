"use client";

// Calls tab (Telegram style): every 1:1 call across your chats, newest first. All / Missed, consecutive calls with the
// same person + direction folded into one row "(3)", tap the row → chat, tap the phone/camera → call back.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  Loader2,
  Phone,
  Video,
} from "lucide-react";
import type { DirectMessage, PublicUser } from "@/lib/types";
import { useApp } from "@/components/AppProvider";
import { TopBar } from "@/components/TopBar";
import { Avatar } from "@/components/Avatar";
import { foldCalls } from "@/lib/calls/history";
import { startCall } from "@/components/calls/CallProvider";
import { displayUser, useDeletedIds } from "@/lib/userDisplay";
import { formatListTime, useClockTick } from "@/lib/time";
import { cn } from "@/lib/utils";

export default function CallsPage() {
  useDeletedIds();
  useClockTick();
  const { request, socket, me } = useApp();
  const meId = me?.id ?? null;
  const [calls, setCalls] = useState<DirectMessage[] | null>(null);
  const [peers, setPeers] = useState<Record<string, PublicUser | null>>({});
  const [tab, setTab] = useState<"all" | "missed">("all");

  const load = useCallback(() => {
    request<{
      calls: DirectMessage[];
      peers: Record<string, PublicUser | null>;
    }>("call:history", {})
      .then((r) => {
        setCalls(r.calls ?? []);
        setPeers(r.peers ?? {});
      })
      .catch(() => setCalls((c) => c ?? []));
  }, [request]);
  useEffect(() => {
    if (meId) load();
  }, [meId, load]);

  // a call ending anywhere lands as a call service message → refresh (cheap: one ack)
  useEffect(() => {
    if (!socket) return;
    const onMsg = (m: DirectMessage) => m.kind === "call" && load();
    socket.on("dm:message", onMsg);
    return () => socket.off("dm:message", onMsg);
  }, [socket, load]);

  const rows = useMemo(() => {
    if (!calls || !meId) return [];
    const all = foldCalls(calls, meId);
    return tab === "missed" ? all.filter((r) => r.missed) : all;
  }, [calls, meId, tab]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-2 pt-4 pb-24">
        <div className="mb-3 flex items-center gap-2 px-1">
          <Link
            href="/messages"
            aria-label="Back to messages"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-zinc-300 hover:bg-white/5"
          >
            <ChevronLeft className="h-6 w-6" />
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-2xl font-bold tracking-tight">
            Calls
          </h1>
          <div
            role="tablist"
            aria-label="Filter calls"
            className="flex shrink-0 rounded-full bg-white/5 p-1 text-sm font-semibold"
          >
            {(["all", "missed"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                data-testid={`calls-tab-${t}`}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-full px-3.5 py-1.5 transition",
                  tab === t
                    ? "bg-white/15 text-white"
                    : "text-zinc-400 hover:text-zinc-200",
                )}
              >
                {t === "all" ? "All" : "Missed"}
              </button>
            ))}
          </div>
        </div>

        {calls === null ? (
          <div className="grid place-items-center py-16 text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div
            className="mx-2 rounded-3xl border border-dashed border-white/10 p-10 text-center text-zinc-500"
            data-testid="calls-empty"
          >
            <div className="mb-2 text-3xl">📞</div>
            {tab === "missed" ? "No missed calls." : "No calls yet."}
            <br />
            Open a chat and tap{" "}
            <Phone className="inline h-4 w-4 align-[-2px]" /> or{" "}
            <Video className="inline h-4 w-4 align-[-2px]" /> to call.
          </div>
        ) : (
          <ul data-testid="calls-list">
            {rows.map((r) => {
              const p = displayUser(peers[r.peerId]);
              const name = p?.name ?? "Open Lounge user";
              const Arrow = r.outgoing ? ArrowUpRight : ArrowDownLeft;
              return (
                <li
                  key={r.key}
                  data-testid="calls-row"
                  data-missed={r.missed ? "1" : "0"}
                  className="flex items-center gap-1 rounded-2xl py-1.5 pl-2 hover:bg-white/[0.03]"
                >
                  <Link
                    href={`/messages/${r.peerId}`}
                    className="flex min-w-0 flex-1 items-center gap-3 [@media(max-width:340px)]:gap-2"
                  >
                    <Avatar
                      name={name}
                      color={p?.color ?? "#64748B"}
                      photo={p?.photoUrl}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "truncate text-[16px] font-semibold",
                          r.missed ? "text-red-400" : "text-zinc-100",
                        )}
                      >
                        {name}
                        {r.count > 1 && (
                          <span className="font-normal"> ({r.count})</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[13px] text-zinc-400">
                        <Arrow
                          className={cn(
                            "h-3.5 w-3.5 shrink-0",
                            r.missed ? "text-red-400" : "text-emerald-400",
                          )}
                          strokeWidth={2.5}
                        />
                        <span className="truncate">
                          {r.missed
                            ? "Missed"
                            : r.outgoing
                              ? "Outgoing"
                              : "Incoming"}
                          {r.video ? " video" : ""}
                          {!r.missed && r.first.call?.durationSec
                            ? ` · ${Math.floor(r.first.call.durationSec / 60)}:${String(r.first.call.durationSec % 60).padStart(2, "0")}`
                            : ""}
                        </span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[12px] text-zinc-500 tabular-nums">
                      {formatListTime(r.first.createdAt)}
                    </span>
                  </Link>
                  <button
                    type="button"
                    disabled={!p}
                    data-testid="calls-row-call"
                    aria-label={r.video ? `Video call ${name}` : `Call ${name}`}
                    onClick={() =>
                      p &&
                      startCall(
                        {
                          id: p.id,
                          name: p.name,
                          color: p.color,
                          photoUrl: p.photoUrl ?? null,
                          username: p.username,
                        },
                        r.video,
                      )
                    }
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-emerald-400 transition hover:bg-emerald-500/10 active:scale-90 disabled:opacity-40"
                  >
                    {r.video ? (
                      <Video className="h-5 w-5" />
                    ) : (
                      <Phone className="h-5 w-5" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
