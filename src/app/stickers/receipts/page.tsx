"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, RotateCcw } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useApp } from "@/components/AppProvider";
import { loadReceipts, restorePurchases } from "@/lib/stickers/client";
import { formatPrice, type Receipt } from "@/lib/stickers/types";
import { formatFull } from "@/lib/time";
import { cn } from "@/lib/utils";
import { SUPPORT_EMAIL } from "@/lib/support";

const STATUS: Record<Receipt["status"], string> = { created: "Pending", captured: "Paid", refunded: "Refunded", reversed: "Reversed", failed: "Failed" };
const VIA: Record<string, string> = { paypal: "PayPal", apple_pay: "Apple Pay", google_pay: "Google Pay", card: "Card" };

export default function ReceiptsPage() {
  const { toast } = useApp();
  const [list, setList] = useState<Receipt[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadReceipts().then(setList).catch(() => setList([]));
  }, []);
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))]">
          <Link href="/stickers" className="-ml-1 mb-2 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
            <ChevronLeft className="h-4 w-4" /> Stickers
          </Link>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Purchases</h1>
            <button
              type="button"
              disabled={busy}
              data-testid="restore-purchases"
              onClick={async () => {
                setBusy(true);
                try {
                  setList(await restorePurchases());
                  toast("Purchases restored");
                } catch (e) {
                  toast((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Restore purchases
            </button>
          </div>
          {list === null ? (
            <div className="grid h-24 place-items-center text-zinc-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : list.length === 0 ? (
            <p className="rounded-2xl bg-white/[0.03] p-4 text-sm text-zinc-400" data-testid="no-receipts">No purchases yet. All starter sticker packs are free.</p>
          ) : (
            <ul className="divide-y divide-white/5 rounded-2xl bg-white/[0.03]">
              {list.map((r) => (
                <li key={r.orderId} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{r.packId.includes(":") ? r.packTitle : `Open Lounge sticker pack: ${r.packTitle}`}</div>
                    <div className="text-[12px] text-zinc-500">
                      {formatFull(r.capturedAt ?? r.createdAt)} · {r.fundingSource ? VIA[r.fundingSource] ?? r.fundingSource : "PayPal"} · {r.orderId}
                      {r.mode === "sandbox" && " · sandbox test"}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold">{formatPrice(r.amountCents, r.currency)}</div>
                    <div className={cn("text-[12px]", r.status === "captured" ? "text-emerald-400" : r.status === "refunded" || r.status === "reversed" ? "text-amber-300" : "text-zinc-500")}>{STATUS[r.status]}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <section className="mt-6 text-[13px] leading-relaxed text-zinc-500" data-testid="purchase-terms">
            <h2 className="mb-1 font-semibold text-zinc-300">Sticker purchase terms</h2>
            <p>
              Sticker packs are digital items sold by Open Lounge and paid through PayPal (including Apple Pay and Google Pay on the web). A purchase gives your
              account a personal, non-transferable license to send that pack&apos;s stickers in Open Lounge; anyone you send them to can see them. Purchases are
              tied to your account and restore on every device you sign in to. If something is wrong, email{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">{SUPPORT_EMAIL}</a> within 14 days for a refund; refunded or charged-back packs are removed
              from My stickers. Prices are in US dollars and include any applicable tax unless shown otherwise.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
