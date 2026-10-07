"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Sheet } from "../Sheet";
import { SUPPORT_MAILTO } from "@/lib/support";
import { REPORT_REASONS, sendReport, type ReportTarget } from "@/lib/safety";

const TITLES: Record<ReportTarget["type"], string> = { user: "Report account", room: "Report room", message: "Report message", dm: "Report message" };

/** Reason picker + optional note → POST /api/reports. */
export function ReportSheet({ target, onClose, onBlock }: { target: ReportTarget | null; onClose: () => void; onBlock?: () => void }) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason(null);
    setNote("");
    setDone(false);
    setError(null);
  }, [target?.type, target?.id]);

  if (!target) return null;
  return (
    <Sheet open={!!target} onClose={onClose} title={done ? "Thanks for letting us know" : TITLES[target.type]}>
      {done ? (
        <div className="space-y-4 text-sm text-zinc-300">
          <div className="flex items-center gap-3 rounded-2xl bg-emerald-500/10 p-4 text-emerald-300">
            <Check className="h-5 w-5 shrink-0" /> Your report was sent. Our team reviews reports within 24 hours and removes content and accounts that break our Terms.
          </div>
          {onBlock && (
            <button onClick={onBlock} className="w-full rounded-full border border-red-500/40 py-3 font-semibold text-red-400 hover:bg-red-500/10">
              Block this account too
            </button>
          )}
          <button onClick={onClose} className="w-full rounded-full bg-emerald-500 py-3 font-semibold text-on-accent hover:bg-emerald-400">
            Done
          </button>
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reason) return;
            setBusy(true);
            setError(null);
            try {
              await sendReport(target, reason, note.trim());
              setDone(true);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {target.label && <p className="mb-3 line-clamp-3 rounded-xl bg-white/5 px-3 py-2 text-sm text-zinc-400">“{target.label}”</p>}
          <p className="mb-2 text-sm text-zinc-400">Why are you reporting this? Reports are confidential.</p>
          <div role="radiogroup" className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-950/40">
            {REPORT_REASONS.map((r, i) => (
              <button
                type="button"
                role="radio"
                aria-checked={reason === r.id}
                key={r.id}
                onClick={() => setReason(r.id)}
                className={"flex min-h-12 w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-white/5 " + (i ? "border-t border-white/5" : "")}
              >
                {r.label}
                <span className={"flex h-5 w-5 items-center justify-center rounded-full border " + (reason === r.id ? "border-emerald-400 bg-emerald-500 text-on-accent" : "border-zinc-600")}>
                  {reason === r.id && <Check className="h-3 w-3" />}
                </span>
              </button>
            ))}
          </div>
          <label className="mt-4 block text-sm text-zinc-400">
            Add details (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 1000))}
              rows={3}
              placeholder="Anything that helps us understand what happened"
              className="mt-1.5 w-full resize-none rounded-2xl border border-white/10 bg-zinc-950/60 px-4 py-3 text-base text-zinc-100 outline-none focus:border-emerald-500/60"
            />
          </label>
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={!reason || busy}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-red-500 py-3.5 font-semibold text-white hover:bg-red-400 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Submit report
          </button>
          <p className="mt-3 text-center text-xs text-zinc-500">
            In danger? Contact local emergency services. Other questions:{" "}
            <a className="underline" href={SUPPORT_MAILTO}>
              support
            </a>
          </p>
        </form>
      )}
    </Sheet>
  );
}
