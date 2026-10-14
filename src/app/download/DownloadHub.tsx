"use client";

import { useEffect, useRef, useState } from "react";
import { useScrollLock } from "@/lib/scrollLock";

const ANDROID = {
  file: "/downloads/openlounge-0.3.5.apk",
  version: "0.3.5 (build 17)",
  size: "7.0 MB",
  sha256: "8c584af9405025e8467abd5688a5d5be62f4face147fab86a6134502c3647a44",
};
const TESTFLIGHT = "https://testflight.apple.com/join/A4khvX7x";
const IOS = {
  install: "itms-services://?action=download-manifest&url=https://openlounge.app/downloads/openlounge-ios.plist",
  file: "/downloads/openlounge-0.3.3-b23.ipa",
  version: "0.3.3 (build 23)",
  size: "8.9 MB",
  sha256: "6856bc24f5f638df0aede9fdb5fb59bb85b37ceaecb47a8c08a5a331bae69ab5",
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

        <section className="mb-5 rounded-2xl border border-sky-400/40 bg-sky-500/[0.06] p-5" data-testid="testflight-section">
          <h2 className="text-base font-semibold text-zinc-100">iPhone: TestFlight (App Store-signed, works on any iPhone)</h2>
          <a
            ref={firstRef}
            href={TESTFLIGHT}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 block rounded-full bg-sky-500 px-5 py-3 text-center font-semibold text-black"
            data-testid="download-ios-testflight"
          >
            Get it on TestFlight
          </a>
          <p className="mt-3 text-zinc-500">Latest: version 0.3.2 (build 21). The public TestFlight link starts serving build 21 once Apple finishes its beta review.</p>
          <p className="mt-3 text-zinc-400">Install Apple&rsquo;s free TestFlight app first.</p>
        </section>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="text-base font-semibold text-zinc-100">Android</h2>
          <p className="text-zinc-500">Version {ANDROID.version} · {ANDROID.size}</p>
          <a
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
          <ul className="mt-3 list-disc space-y-1 pl-5 text-zinc-400">
            <li>Only iPhones registered for this test build can install it.</li>
            <li>Open this page in Safari, tap Install, then check your home screen.</li>
            <li>No profile trust step in VPN &amp; Device Management is needed. On iOS 16+, you may need to turn on Settings &gt; Privacy &amp; Security &gt; Developer Mode.</li>
          </ul>
          <p className="mt-3 text-xs text-zinc-500">
            Direct file: <a className="underline" href={IOS.file}>openlounge-0.3.3-b23.ipa</a>
          </p>
          <Sha value={IOS.sha256} />
        </section>
      </div>
    </main>
  );
}
