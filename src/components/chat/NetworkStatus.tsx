"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";

/** WhatsApp-style quiet status under a title: "Waiting for network…" (device offline) / "Connecting…" (online, socket
 *  not up yet). Hidden while connected; a short grace keeps reconnect blips from flickering it. */
export function NetworkStatus({ className = "" }: { className?: string }) {
  const { connected } = useApp();
  const [show, setShow] = useState(false);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const upd = () => setOnline(typeof navigator === "undefined" || navigator.onLine !== false);
    upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
    };
  }, []);
  useEffect(() => {
    if (connected) return setShow(false);
    const t = setTimeout(() => setShow(true), online ? 1500 : 400);
    return () => clearTimeout(t);
  }, [connected, online]);
  if (!show || connected) return null;
  return (
    <p role="status" aria-live="polite" data-testid="network-status" className={`fade-in text-xs font-medium text-zinc-400 ${className}`}>
      {online ? "Connecting…" : "Waiting for network…"}
    </p>
  );
}
