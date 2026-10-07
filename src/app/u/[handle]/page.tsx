import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchPublicCard } from "@/lib/publicProfile";
import { PUBLIC_ORIGIN } from "@/lib/links";
import { ShareProfileButton } from "@/components/ShareProfileButton";

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const u = await fetchPublicCard(handle);
  if (!u) return { title: "Open Lounge" };
  const title = `${u.name} (@${u.username}) on Open Lounge`;
  const description = u.bio || `Join ${u.name.split(" ")[0]} in live audio rooms on Open Lounge.`;
  const url = `${PUBLIC_ORIGIN}/@${u.username}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "Open Lounge", type: "profile" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicProfile({ params }: Props) {
  const { handle } = await params;
  const u = await fetchPublicCard(handle);
  if (!u) notFound();
  const initials = u.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-6 text-lg font-bold tracking-tight">🎙️ Open Lounge</div>
      <div className="w-full rounded-3xl border border-white/5 bg-zinc-900/70 p-8">
        {u.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={u.photoUrl} alt="" className="mx-auto h-24 w-24 rounded-[36%] object-cover" />
        ) : (
          <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[36%] text-3xl font-bold text-on-color" style={{ background: u.color }}>
            {initials}
          </div>
        )}
        <h1 className="mt-4 text-2xl font-bold">{u.name}</h1>
        <div className="text-sm text-zinc-500">@{u.username}</div>
        {u.bio && <p className="mt-3 text-sm leading-relaxed text-zinc-300">{u.bio}</p>}
        <div className="mt-4 flex justify-center gap-6 text-sm">
          <span>
            <b>{u.followers}</b> <span className="text-zinc-500">followers</span>
          </span>
          <span>
            <b>{u.following}</b> <span className="text-zinc-500">following</span>
          </span>
        </div>
        <Link href={`/profile/${u.id}`} className="mt-6 block w-full rounded-full bg-emerald-500 py-3 font-semibold text-on-accent hover:bg-emerald-400">
          Open in Open Lounge
        </Link>
        <ShareProfileButton username={u.username} name={u.name} className="mt-2 w-full justify-center" />
      </div>
      <p className="mt-6 text-xs text-zinc-500">Live audio rooms with people you follow.</p>
    </main>
  );
}
