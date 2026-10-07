"use client";

import { useEffect, useRef, useState } from "react";

export function DownloadHub() {
  const [open, setOpen] = useState(false);
  const tabRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        tabRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden p-6">
      <img src="/downloads/qr.png" alt="QR code to openlounge.app/download" className="w-64 max-w-[80vw] rounded-3xl bg-white p-3 md:w-80" data-testid="download-qr" />

      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setOpen(false)} aria-hidden="true" />}

      <button
        ref={tabRef}
        type="button"
        aria-expanded={open}
        aria-controls="get-app-drawer"
        onClick={() => setOpen((o) => !o)}
        data-testid="get-app-tab"
        className={`fixed top-1/2 z-50 -translate-y-1/2 rounded-l-xl bg-zinc-800 px-2 py-4 text-sm font-semibold text-zinc-100 shadow-lg transition-[right] duration-300 [writing-mode:vertical-rl] ${open ? "right-72" : "right-0"}`}
      >
        Get the app
      </button>

      <div
        id="get-app-drawer"
        role="dialog"
        aria-label="Get the app"
        aria-hidden={!open}
        inert={!open}
        className={`fixed top-0 right-0 z-50 flex h-full w-72 flex-col justify-center gap-4 bg-zinc-900 p-6 shadow-2xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="absolute top-4 right-4 rounded-full p-2 text-xl leading-none text-zinc-400 hover:text-white">
          ×
        </button>
        <a ref={firstRef} href="/downloads/openlounge-0.2.8.apk" download data-testid="download-android" className="block rounded-full bg-emerald-500 px-5 py-3 text-center font-semibold text-black">
          Download for Android
        </a>
        <a
          href="itms-services://?action=download-manifest&url=https://openlounge.app/downloads/openlounge-ios.plist"
          data-testid="download-ios"
          className="block rounded-full bg-sky-500 px-5 py-3 text-center font-semibold text-black"
        >
          Install for iPhone
        </a>
      </div>
    </main>
  );
}
