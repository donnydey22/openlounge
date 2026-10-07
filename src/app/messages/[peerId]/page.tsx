"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DmThread } from "@/components/chat/DmThread";

/**
 * Height of the visible area: shrinks with the on-screen keyboard (iOS Safari doesn't resize the
 * layout viewport, Android may or may not) so the composer stays pinned right above the keyboard
 * and the header never scrolls away. Falls back to 100dvh.
 */
function useVisualViewport() {
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setVv((prev) => (prev && prev.h === v.height && prev.top === v.offsetTop ? prev : { h: v.height, top: v.offsetTop }));
        // iOS scrolls the whole page up when the keyboard opens; keep the document still
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };
    update();
    v.addEventListener("resize", update);
    v.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("resize", update);
      v.removeEventListener("scroll", update);
    };
  }, []);
  return vv;
}

export default function ConversationPage() {
  const { peerId } = useParams<{ peerId: string }>();
  const router = useRouter();
  const vv = useVisualViewport();
  return (
    <div className="fixed inset-x-0 top-0 z-10 bg-app" style={{ height: vv ? vv.h : "100dvh", transform: vv?.top ? `translateY(${vv.top}px)` : undefined }}>
      <DmThread peerId={peerId} onBack={() => router.push("/messages")} className="mx-auto h-full max-w-2xl" />
    </div>
  );
}
