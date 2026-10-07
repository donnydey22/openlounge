"use client";

import { useEffect, useState } from "react";

type Platform = "android" | "ios" | "web";

const CARDS: {
  id: Platform;
  name: string;
  sub: string;
  href: string;
  button: string;
  download?: boolean;
  testid: string;
  details: React.ReactNode;
}[] = [
  {
    id: "android",
    name: "Android",
    sub: "Version 0.2.8 (build 10) · 6.9 MB",
    href: "/downloads/openlounge-0.2.8.apk",
    button: "Download for Android",
    download: true,
    testid: "download-android",
    details: (
      <>
        <p>
          Open the downloaded file to install. If Android blocks it, allow &ldquo;Install unknown apps&rdquo; for your browser when prompted (Settings &gt; Apps &gt; your
          browser &gt; Install unknown apps).
        </p>
        <p className="mt-2">
          SHA-256: <code className="break-all">962fab2b666ef958bf128d7d7f76c872bc31fa8c928d7f7fbb59cbdb9dd2e5d7</code>
        </p>
      </>
    ),
  },
  {
    id: "ios",
    name: "iPhone",
    sub: "Version 0.2.5 (build 14) · 8.6 MB",
    href: "itms-services://?action=download-manifest&url=https://openlounge.app/downloads/openlounge-ios.plist",
    button: "Install on iPhone",
    testid: "download-ios",
    details: (
      <>
        <ul className="list-disc space-y-1 pl-5">
          <li>Only iPhones registered for this test build can install it.</li>
          <li>Open this page in Safari, tap Install, then check your home screen.</li>
          <li>No profile trust step in VPN &amp; Device Management is needed. On iOS 16+, you may need to turn on Settings &gt; Privacy &amp; Security &gt; Developer Mode.</li>
        </ul>
        <p className="mt-2">
          Direct file:{" "}
          <a className="underline" href="/downloads/openlounge-0.2.5-b14.ipa">
            openlounge-0.2.5-b14.ipa
          </a>
        </p>
        <p className="mt-2">
          SHA-256: <code className="break-all">942b794b5b3e618d9efdfcf47fd8faa31954624eec6a263bca058b9d312fbe3e</code>
        </p>
      </>
    ),
  },
  {
    id: "web",
    name: "Web",
    sub: "Use in your browser",
    href: "https://openlounge.app/",
    button: "Open Open Lounge in your browser",
    testid: "open-web",
    details: <p>Works on any phone or computer. Nothing to install.</p>,
  },
];

const ICON: Record<Platform, string> = { android: "🤖", ios: "📱", web: "🌐" };

export function DownloadHub() {
  const [mine, setMine] = useState<Platform | null>(null);
  useEffect(() => {
    const ua = navigator.userAgent;
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    setMine(/Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/i.test(ua) || iPadOS ? "ios" : "web");
  }, []);
  const ordered = mine ? [...CARDS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine)) : CARDS;

  return (
    <main className="mx-auto max-w-5xl px-5 pb-12 text-sm leading-relaxed text-zinc-300">
      <section className="flex flex-col items-center gap-6 py-10 text-center md:flex-row md:justify-between md:text-left">
        <div>
          <div className="text-6xl md:text-7xl" aria-hidden="true">🎙️</div>
          <p className="mt-1 text-xs text-zinc-500" data-testid="tagline">Message privately. Stay open.</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-zinc-100 md:text-5xl">Open Lounge for every device</h1>
          <p className="mt-2 text-zinc-500 md:text-base">Live audio rooms on Android, iPhone and the web.</p>
        </div>
        <figure className="flex flex-col items-center">
          <img src="/downloads/qr.png" alt="QR code for openlounge.app/download" className="w-32 rounded-2xl bg-white p-2 md:w-52" data-testid="download-qr" />
          <figcaption className="mt-2 text-xs text-zinc-500 md:text-sm">Scan to open on your phone</figcaption>
        </figure>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        {ordered.map((c) => {
          const hi = c.id === mine;
          return (
            <section
              key={c.id}
              data-testid={`card-${c.id}`}
              className={`flex flex-col rounded-2xl border p-5 ${hi ? "border-sky-400/60 bg-sky-400/[0.07]" : "border-white/10 bg-white/[0.03]"}`}
            >
              <div className="flex items-center gap-3">
                <span className="text-3xl" aria-hidden="true">{ICON[c.id]}</span>
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">
                    {c.name}
                    {hi && <span className="ml-2 rounded-full bg-sky-400/20 px-2 py-0.5 text-[11px] font-medium text-sky-300">Your device</span>}
                  </h2>
                  <p className="text-zinc-500">{c.sub}</p>
                </div>
              </div>
              <a
                href={c.href}
                download={c.download || undefined}
                data-testid={c.testid}
                className={`mt-4 block rounded-full px-5 py-3 text-center font-semibold text-black ${hi ? "bg-sky-400" : "bg-white"}`}
              >
                {c.button}
              </a>
              <details className="mt-3 text-xs text-zinc-500">
                <summary className="cursor-pointer select-none">Details</summary>
                <div className="mt-2">{c.details}</div>
              </details>
            </section>
          );
        })}
      </div>
    </main>
  );
}
