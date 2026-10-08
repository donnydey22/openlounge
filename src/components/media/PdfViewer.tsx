"use client";
// In-app PDF viewer. Placeholder until step 3 lands pdf.js: opens the signed inline URL in a sandboxed frame.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { getUrls } from "@/lib/media/client";
import { closeViewer, type ViewerTarget } from "./viewerStore";

export function PdfViewer({ target }: { target: ViewerTarget }) {
  const a = target.message.media!;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    void getUrls(a, true).then((u) => setUrl(u.full ?? null));
  }, [a]);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-zinc-950" role="dialog" aria-modal="true">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <button onClick={closeViewer} className="rounded-full p-2 text-zinc-200 hover:bg-white/10" aria-label="Close">
          <X className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1 truncate font-semibold">{a.name}</div>
      </div>
      {url && <iframe src={url} title={a.name ?? "PDF"} className="min-h-0 w-full flex-1 bg-white" />}
    </div>,
    document.body,
  );
}
