"use client";

import { useEffect, useRef, useState } from "react";
import { useScrollLock } from "@/lib/scrollLock";

const ANDROID = {
  file: "/downloads/openlounge-0.3.9.apk",
  version: "0.3.9 (build 21)",
  size: "6.8 MB",
  sha256: "f41fcfb3978226e8a50b5885159bdef00c3b5dec3a8e29cadef5373bdd3908a6",
};
const IOS = {
  install: "itms-services://?action=download-manifest&url=https://openlounge.app/downloads/openlounge-ios.plist",
  file: "/downloads/openlounge-ios-0.3.9-b28.ipa",
  version: "0.3.9 (build 28)",
  size: "8.9 MB",
  sha256: "064edebbdfe95df02251d15041a4137027cea8cf1b9be42d662c2527c793f0ca",
};

function Sha({ value }: { value: string }) {
  return (
    <p className="mt-3 text-xs text-zinc-500">
      SHA-256: <code className="break-all text-zinc-400">{value}</code>
    </p>
  );
}

export function DownloadHub() {
  const [open, setOpen] = useState(false);
  useScrollLock(open);
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
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden overflow-x-clip p-6">
      <img src="/downloads/qr.png" alt="QR code to openlounge.app/download" width={984} height={984} className="aspect-square h-auto w-64 max-w-[80vw] rounded-3xl bg-white object-contain md:w-80" data-testid="download-qr" />

      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setOpen(false)} aria-hidden="true" />}

      <button
        ref={tabRef}
        type="button"
        aria-expanded={open}
        aria-controls="get-app-drawer"
        onClick={() => setOpen((o) => !o)}
        data-testid="get-app-tab"
        className={`fixed top-1/2 z-50 -translate-y-1/2 rounded-l-xl bg-zinc-800 px-2 py-4 text-sm font-semibold text-zinc-100 shadow-lg transition-[right] duration-300 [writing-mode:vertical-rl] ${open ? "right-[min(24rem,88vw)]" : "right-0"}`}
      >
        get the app
      </button>

      <div
        id="get-app-drawer"
        role="dialog"
        aria-label="Get the app"
        aria-hidden={!open}
        inert={!open}
        className={`fixed top-0 right-0 z-50 flex h-full w-[min(24rem,88vw)] flex-col overflow-y-auto bg-zinc-950 px-5 py-8 text-sm leading-relaxed text-zinc-300 shadow-2xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="absolute top-4 right-4 rounded-full p-2 text-xl leading-none text-zinc-400 hover:text-white">
          ×
        </button>
        <h1 className="mb-1 text-2xl font-bold text-zinc-100">Get the app</h1>
        <p className="mb-6 text-zinc-500">Test builds for family and friends.</p>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="text-base font-semibold text-zinc-100">Android</h2>
          <p className="text-zinc-500">Version {ANDROID.version} · {ANDROID.size}</p>
          <a
            ref={firstRef}
            href={ANDROID.file}
            download
            className="mt-4 block rounded-full bg-emerald-500 px-5 py-3 text-center font-semibold text-black"
            data-testid="download-android"
          >
            Download for Android
          </a>
          <p className="mt-3 text-zinc-400">
            Open the downloaded file to install. If Android blocks it, allow &ldquo;Install unknown apps&rdquo; for your browser when prompted (Settings &gt; Apps &gt;
            your browser &gt; Install unknown apps).
          </p>
          <Sha value={ANDROID.sha256} />
        </section>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="text-base font-semibold text-zinc-100">iPhone: Direct install (registered devices only)</h2>
          <p className="text-zinc-500">Version {IOS.version} · {IOS.size}</p>
          <a
            href={IOS.install}
            className="mt-4 block rounded-full border border-sky-500/60 px-5 py-3 text-center font-semibold text-sky-300"
            data-testid="download-ios"
          >
            Install on iPhone
          </a>
          <p className="mt-3 text-zinc-500">Latest: version 0.3.4 (build 24)</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-zinc-400">
            <li>Only iPhones registered for this test build can install it.</li>
            <li>Open this page in Safari, tap Install, then check your home screen.</li>
            <li>No profile trust step in VPN &amp; Device Management is needed. On iOS 16+, you may need to turn on Settings &gt; Privacy &amp; Security &gt; Developer Mode.</li>
          </ul>
          <p className="mt-3 text-xs text-zinc-500">
            Direct file: <a className="underline" href={IOS.file}>openlounge-ios-0.3.9-b28.ipa</a>
          </p>
          <Sha value={IOS.sha256} />
        </section>
      </div>
    </main>
  );
}
