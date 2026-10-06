"use client";

import Link from "next/link";
import { useApp } from "./AppProvider";

const CLS =
  "toast-in pointer-events-auto block max-w-md rounded-2xl border border-white/10 bg-zinc-800/95 px-4 py-2.5 text-sm text-zinc-100 shadow-xl backdrop-blur";

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) =>
        t.href ? (
          <Link key={t.id} href={t.href} className={CLS + " hover:bg-zinc-700/95"}>
            {t.message}
          </Link>
        ) : (
          <div key={t.id} className={CLS}>
            {t.message}
          </div>
        ),
      )}
    </div>
  );
}
