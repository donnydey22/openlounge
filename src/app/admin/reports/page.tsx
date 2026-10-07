"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { authFetch } from "@/lib/auth";
import { REPORT_REASONS } from "@/lib/safety";
import { formatFull } from "@/lib/time";
import { cn } from "@/lib/utils";

type Who = { id: string; name: string; username: string } | null;
type Report = {
  id: string;
  targetType: "user" | "room" | "message" | "dm";
  targetId: string;
  roomId: string | null;
  reason: string;
  note: string;
  snapshot: string;
  status: "open" | "reviewed" | "actioned" | "dismissed";
  createdAt: number;
  reporter: Who;
  targetUser: Who;
  reportsAgainstTarget: number;
};

const FILTERS = ["open", "reviewed", "actioned", "dismissed", ""] as const;
const reasonLabel = (id: string) => REPORT_REASONS.find((r) => r.id === id)?.label ?? id;

/** Admin-only (server checks ADMIN_USER_IDS): list content reports and mark them handled. */
export default function AdminReportsPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("open");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await authFetch(`/api/admin/reports${filter ? `?status=${filter}` : ""}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(r.status === 403 ? "This page is for Open Lounge admins only." : d?.error || "Couldn't load reports");
      setReports(d.reports);
    } catch (e) {
      setError((e as Error).message);
      setReports([]);
    }
  }, [filter]);

  useEffect(() => {
    setReports(null);
    void load();
  }, [load]);

  const setStatus = async (id: string, status: Report["status"]) => {
    setBusy(id);
    try {
      const r = await authFetch(`/api/admin/reports/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      if (r.ok) setReports((list) => (list ?? []).map((x) => (x.id === id ? { ...x, status } : x)).filter((x) => !filter || x.status === filter));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))]">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <button onClick={() => void load()} className="rounded-full p-2.5 text-zinc-400 hover:bg-white/5" aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map((f) => (
            <button
              key={f || "all"}
              onClick={() => setFilter(f)}
              className={cn(
                "shrink-0 rounded-full border px-3.5 py-1.5 text-sm capitalize",
                filter === f ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300" : "border-white/10 text-zinc-400 hover:bg-white/5",
              )}
            >
              {f || "all"}
            </button>
          ))}
        </div>
        {error && <p className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">{error}</p>}
        {reports === null ? (
          <div className="flex justify-center py-16 text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : reports.length === 0 && !error ? (
          <p className="py-16 text-center text-sm text-zinc-500">No {filter} reports. 🎉</p>
        ) : (
          <ul className="space-y-3">
            {reports.map((r) => (
              <li key={r.id} className="rounded-2xl border border-white/5 bg-zinc-900/70 p-4 text-sm" data-testid="admin-report">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-300">{reasonLabel(r.reason)}</span>
                  <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-zinc-400">{r.targetType === "dm" ? "direct message" : r.targetType}</span>
                  <span className="text-xs text-zinc-500 capitalize">{r.status}</span>
                  <span className="ml-auto text-xs text-zinc-500">{formatFull(r.createdAt)}</span>
                </div>
                {r.snapshot && <p className="mt-3 rounded-xl bg-zinc-950/60 px-3 py-2 break-words whitespace-pre-wrap text-zinc-200">{r.snapshot}</p>}
                {r.note && <p className="mt-2 text-zinc-400">Note: {r.note}</p>}
                <div className="mt-3 space-y-0.5 text-xs text-zinc-500">
                  <div>
                    Against:{" "}
                    {r.targetUser ? (
                      <Link className="text-sky-400 hover:underline" href={`/profile/${r.targetUser.id}`}>
                        {r.targetUser.name} {r.targetUser.username && `@${r.targetUser.username}`}
                      </Link>
                    ) : (
                      "—"
                    )}{" "}
                    · {r.reportsAgainstTarget} report{r.reportsAgainstTarget === 1 ? "" : "s"} total
                  </div>
                  <div>
                    By: {r.reporter ? `${r.reporter.name} @${r.reporter.username}` : "—"}
                    {r.roomId && (
                      <>
                        {" "}
                        · room{" "}
                        <Link className="text-sky-400 hover:underline" href={`/room/${r.roomId}`}>
                          {r.roomId}
                        </Link>
                      </>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-600">{r.id}</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(["reviewed", "actioned", "dismissed", "open"] as const)
                    .filter((s) => s !== r.status)
                    .map((s) => (
                      <button
                        key={s}
                        disabled={busy === r.id}
                        onClick={() => void setStatus(r.id, s)}
                        className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-300 capitalize hover:bg-white/5 disabled:opacity-40"
                      >
                        {s === "open" ? "Reopen" : `Mark ${s}`}
                      </button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
