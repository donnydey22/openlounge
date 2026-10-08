"use client";
// Verification review queue (admins only). ID/business documents are private: fetched with the admin token, shown
// from a blob URL, never cached, and deleted on the server as soon as a request is approved or rejected.
import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Check, FileText, Loader2, X } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useApp } from "@/components/AppProvider";
import { authFetch } from "@/lib/auth";
import { monetApi } from "@/lib/premium/client";
import { formatPrice } from "@/lib/stickers/types";
import type { VerificationRequest } from "@/lib/creator/types";
import { cn } from "@/lib/utils";

interface AdminData { enabled: boolean; queue: VerificationRequest[]; awaitingPayment: number; verified: { id: string; verified: "creator" | "business"; since: number; name: string }[] }

export default function CreatorAdminPage() {
  const { toast } = useApp();
  const [d, setD] = useState<AdminData | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    monetApi<AdminData>("/api/admin/creator").then(setD).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const act = async (body: Record<string, unknown>) => {
    try {
      await monetApi("/api/admin/creator", { body });
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-4 pt-4 pb-10" data-testid="creator-admin">
          <h1 className="mb-1 text-2xl font-bold tracking-tight">Verification (admin)</h1>
          {err ? <p className="text-sm text-rose-300">{err}</p> : !d ? <Loader2 className="h-5 w-5 animate-spin text-zinc-500" /> : (
            <>
              <p className="mb-4 text-sm text-zinc-400">
                {d.enabled ? "Creator accounts are on." : "CREATOR_ENABLED is off — nothing is shown to people."} {d.queue.length} to review · {d.awaitingPayment} waiting for payment.
              </p>
              {!d.queue.length && <p className="rounded-2xl border border-white/10 p-4 text-sm text-zinc-400" data-testid="creator-queue-empty">No requests to review.</p>}
              <ul className="space-y-3">{d.queue.map((r) => <ReviewCard key={r.id} r={r} act={act} />)}</ul>
              <h2 className="mt-8 mb-2 text-sm font-semibold text-zinc-300">Verified ({d.verified.length})</h2>
              <ul className="divide-y divide-white/5 rounded-2xl border border-white/10">
                {d.verified.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <BadgeCheck className={cn("h-4 w-4", v.verified === "business" ? "text-amber-300" : "text-sky-400")} />
                    <a href={`/profile/${v.id}`} className="flex-1 truncate hover:underline">{v.name || v.id}</a>
                    <span className="text-xs text-zinc-500">{v.verified} · {new Date(v.since).toLocaleDateString()}</span>
                    <button className="text-xs text-rose-300 underline" onClick={() => { const note = prompt("Reason for removing the badge?"); if (note) void act({ op: "revoke", userId: v.id, note }); }}>Revoke</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function ReviewCard({ r, act }: { r: VerificationRequest; act: (b: Record<string, unknown>) => Promise<void> }) {
  const { toast } = useApp();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  useEffect(() => () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const view = async (id: string, mime: string) => {
    try {
      const res = await authFetch(`/api/admin/creator/doc/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Document unavailable");
      const u = URL.createObjectURL(await res.blob());
      if (mime === "application/pdf") window.open(u, "_blank", "noopener");
      else setUrls((m) => ({ ...m, [id]: u }));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <li className="rounded-2xl border border-white/10 p-4" data-testid="creator-review">
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-semibold">{r.legalName}</span>
        {r.businessName && <span className="text-zinc-300">{r.businessName}</span>}
        <span className="rounded-full bg-white/5 px-2 text-xs capitalize">{r.kind}</span>
        <span className="text-xs text-zinc-500">{r.country} · {r.feeCents ? `paid ${formatPrice(r.feeCents, "USD")}` : "fee waived"} · {new Date(r.createdAt).toLocaleString()}</span>
      </div>
      <div className="mt-1 text-xs text-zinc-400">
        User <a className="underline" href={`/profile/${r.userId}`}>{r.userId}</a>
        {r.website && <> · <a className="underline" href={r.website} target="_blank" rel="noopener noreferrer nofollow">{r.website}</a></>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {r.docs.map((doc) => (
          <div key={doc.id}>
            {urls[doc.id] ? <img src={urls[doc.id]} alt={doc.label} className="max-h-64 rounded-lg" /> : (
              <button onClick={() => view(doc.id, doc.mime)} className="inline-flex items-center gap-1 rounded-full bg-white/5 px-3 py-1.5 text-xs" data-testid="creator-doc"><FileText className="h-3.5 w-3.5" /> {doc.label}</button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => act({ op: "approve", id: r.id })} className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-black" data-testid="creator-approve"><Check className="h-4 w-4" /> Approve</button>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (shown to them)" className="order-last min-w-0 basis-full rounded-full sm:order-none sm:basis-auto sm:flex-1 border border-white/10 bg-zinc-900 px-3 py-1.5 text-sm" />
        <button onClick={() => (note.trim() ? act({ op: "reject", id: r.id, note }) : toast("Add a reason"))} className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 px-3 py-1.5 text-sm text-rose-200" data-testid="creator-reject"><X className="h-4 w-4" /> Reject</button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">Rejecting doesn&apos;t refund automatically — refund in PayPal if needed (the badge is removed on refund).</p>
    </li>
  );
}
