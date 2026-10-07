import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Download — Open Lounge" };
export const dynamic = "force-static";

const ANDROID = {
  file: "/downloads/openlounge-0.2.8.apk",
  version: "0.2.8 (build 10)",
  size: "6.9 MB",
  sha256: "962fab2b666ef958bf128d7d7f76c872bc31fa8c928d7f7fbb59cbdb9dd2e5d7",
};
const IOS = {
  install: "itms-services://?action=download-manifest&url=https://openlounge.app/downloads/openlounge-ios.plist",
  file: "/downloads/openlounge-0.2.5-b14.ipa",
  version: "0.2.5 (build 14)",
  size: "8.6 MB",
  sha256: "942b794b5b3e618d9efdfcf47fd8faa31954624eec6a263bca058b9d312fbe3e",
};

function Sha({ value }: { value: string }) {
  return (
    <p className="mt-3 text-xs text-zinc-500">
      SHA-256: <code className="break-all text-zinc-400">{value}</code>
    </p>
  );
}

export default function Download() {
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-white/5 bg-app/80 pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-2xl items-center px-4">
          <Link href="/" className="inline-flex items-center gap-2 text-lg" aria-label="Open Lounge">
            <span className="text-2xl" aria-hidden="true">🎙️</span>
            <span className="ol-word font-bold tracking-tight whitespace-nowrap">Open Lounge</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-5 py-8 text-sm leading-relaxed text-zinc-300">
        <h1 className="mb-1 text-2xl font-bold text-zinc-100">Get the app</h1>
        <p className="mb-6 text-zinc-500">Test builds for family and friends.</p>

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
          <h2 className="text-base font-semibold text-zinc-100">iPhone</h2>
          <p className="text-zinc-500">Version {IOS.version} · {IOS.size}</p>
          <a
            href={IOS.install}
            className="mt-4 block rounded-full bg-sky-500 px-5 py-3 text-center font-semibold text-black"
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
            Direct file: <a className="underline" href={IOS.file}>openlounge-0.2.5-b14.ipa</a>
          </p>
          <Sha value={IOS.sha256} />
        </section>
      </main>
    </>
  );
}
