import Link from "next/link";
import type { Metadata } from "next";
import { DownloadHub } from "./DownloadHub";

export const metadata: Metadata = { title: "Download — Open Lounge" };
export const dynamic = "force-static";

export default function Download() {
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-white/5 bg-app/80 pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center px-4">
          <Link href="/" className="inline-flex items-center gap-2 text-lg" aria-label="Open Lounge">
            <span className="text-2xl" aria-hidden="true">🎙️</span>
            <span className="ol-word font-bold tracking-tight whitespace-nowrap">Open Lounge</span>
          </Link>
        </div>
      </header>
      <DownloadHub />
    </>
  );
}
