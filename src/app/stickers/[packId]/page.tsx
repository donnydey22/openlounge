"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2 } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { PackActions, PackBody } from "@/components/stickers/PackSheet";
import { loadConfig, loadMine, loadPack, useStickers } from "@/lib/stickers/client";

export default function PackPage({ params }: { params: Promise<{ packId: string }> }) {
  const { packId } = use(params);
  const pack = useStickers((s) => s.packs[packId] ?? null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void loadPack(packId).then((p) => setMissing(!p));
    void loadMine();
    void loadConfig();
  }, [packId]);
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl px-4 pt-4 pb-6">
          <Link href="/stickers" className="-ml-1 mb-2 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
            <ChevronLeft className="h-4 w-4" /> Stickers
          </Link>
          {pack ? (
            <>
              <h1 className="mb-2 text-2xl font-bold tracking-tight" data-testid="pack-title">
                {pack.title}
              </h1>
              <PackBody pack={pack} size={84} />
            </>
          ) : (
            <div className="grid h-40 place-items-center text-zinc-500">{missing ? "Pack not found" : <Loader2 className="h-5 w-5 animate-spin" />}</div>
          )}
        </div>
      </main>
      {pack && (
        <div className="shrink-0 border-t border-white/5 bg-app/90 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] backdrop-blur-xl">
          <div className="mx-auto max-w-2xl">
            <PackActions pack={pack} />
          </div>
        </div>
      )}
    </div>
  );
}
