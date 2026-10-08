"use client";

// Deep link for a call: push notification tap ("Incoming call") or the native Accept button (/call/<id>?accept=1).
// Hands the call to the global call engine, then shows the chat with that person underneath the call screen.
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Loader2, PhoneOff } from "lucide-react";
import { useApp } from "@/components/AppProvider";
import { callEngine } from "@/lib/calls/engine";

export default function CallLinkPage() {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  const router = useRouter();
  const { connected, me } = useApp();
  const [ended, setEnded] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (done.current || !connected || !me || !id) return;
    done.current = true;
    void callEngine.openFromLink(String(id), q.get("accept") === "1").then(({ peerId, ended }) => {
      if (ended) {
        setEnded(true);
        setTimeout(() => router.replace(peerId ? `/messages/${peerId}` : "/messages"), 1500);
      } else router.replace(peerId ? `/messages/${peerId}` : "/messages");
    });
  }, [connected, me, id, q, router]);

  return (
    <div className="flex h-full min-h-[60dvh] flex-col items-center justify-center gap-3 text-zinc-400">
      {ended ? (
        <>
          <PhoneOff className="h-8 w-8" />
          <div className="text-sm">Call ended</div>
        </>
      ) : (
        <Loader2 className="h-6 w-6 animate-spin" />
      )}
    </div>
  );
}
