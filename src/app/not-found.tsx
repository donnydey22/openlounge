import Link from "next/link";

export const metadata = { title: "Page not found · Open Lounge" };

/** App-styled 404 — safe-area aware so it sits correctly inside the Android/iOS wrappers. */
export default function NotFound() {
  return (
    <main
      className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center text-zinc-100"
      style={{
        background: "rgb(11,11,13)",
        paddingTop: "max(env(safe-area-inset-top), 24px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 24px)",
      }}
      data-testid="not-found"
    >
      <p className="text-sm font-semibold uppercase tracking-widest text-sky-400">404</p>
      <h1 className="mt-3 text-2xl font-bold">This page isn&apos;t here</h1>
      <p className="mt-2 max-w-xs text-zinc-400">The link may be old or mistyped. Head back to the lounge.</p>
      <Link href="/" className="mt-6 rounded-full bg-sky-500 px-6 py-3 font-semibold text-white">
        Back to Open Lounge
      </Link>
    </main>
  );
}
