"use client";

import { useEffect, useRef, useState } from "react";
import { useScrollLock } from "@/lib/scrollLock";
import { ANDROID_RELEASE, IOS_RELEASE, IOS_MANIFEST_URL, CALLING_RELEASE_NOTICE, releaseLabel } from "@/lib/releases";

const ANDROID = { ...ANDROID_RELEASE, version: releaseLabel(ANDROID_RELEASE) };

function Sha({ value }: { value: string }) {
  return (
    <p className="mt-3 text-xs text-zinc-500">
      SHA-256: <code className="break-all text-zinc-400">{value}</code>
    </p>
  );
}

export function DownloadHub() {
  const [open, setOpen] = useState(true);
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
        <p className="mb-3 text-zinc-500">Test builds for family and friends.</p>
        <p role="status" className="mb-6 rounded-xl border border-amber-400/30 p-3 text-xs text-amber-200">{CALLING_RELEASE_NOTICE}</p>

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

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5" data-testid="download-ios">
          <h2 className="text-base font-semibold text-zinc-100">iPhone</h2>
          <p className="text-zinc-500">Version {releaseLabel(IOS_RELEASE)} · {IOS_RELEASE.size}</p>
          <a
            href={IOS_RELEASE.file}
            download
            className="mt-4 block rounded-full bg-emerald-500 px-5 py-3 text-center font-semibold text-black"
            data-testid="download-ios-file"
          >
            Download for iPhone
          </a>
          <a
            href={`itms-services://?action=download-manifest&url=${encodeURIComponent(IOS_MANIFEST_URL)}`}
            className="mt-3 block rounded-full border border-emerald-500/60 px-5 py-3 text-center font-semibold text-emerald-300"
            data-testid="download-ios-install"
          >
            Install on iPhone
          </a>
          <p className="mt-3 text-zinc-400">
            Ad-hoc test build, not an App Store release: installation is limited to iPhones registered in the provisioning profile. Use Safari on a registered iPhone and tap Install, or download the IPA directly. Physical calling tests are pending.
          </p>
          <Sha value={IOS_RELEASE.sha256} />
        </section>

      </div>
    </main>
  );
}
