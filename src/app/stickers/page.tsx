"use client";

import Link from "next/link";
import { Receipt } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { StickerStore } from "@/components/stickers/StickerStore";

export default function StickersPage() {
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl px-4 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom,0px))]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Stickers</h1>
            <Link href="/stickers/receipts" className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10" data-testid="purchases-link">
              <Receipt className="h-4 w-4" /> Purchases
            </Link>
          </div>
          <StickerStore linkPacks />
        </div>
      </main>
    </div>
  );
}
