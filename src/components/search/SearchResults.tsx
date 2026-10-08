"use client";

// Global search pieces (/explore): #/@ suggestions and grouped results: profile card · Messages · Rooms · People.
import { memo, useMemo } from "react";
import Link from "next/link";
import { AtSign, Hash, MessageCircle, Mic, User } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { FollowButton } from "@/components/UserRow";
import { useApp } from "@/components/AppProvider";
import { splitHashtags } from "@/lib/linkify";
import { typingToken } from "@/lib/searchQuery";
import { searchUrl, useHx, type HxMessage, type HxPerson, type HxQuery, type HxResults, type HxSuggestion } from "@/lib/searchClient";
import { cn, timeAgo } from "@/lib/utils";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Plain-text snippet: matched #tags/@mentions in accent + bold, plain search words marked. Nothing clickable inside. */
export function Snippet({ text, query }: { text: string; query?: HxQuery }) {
  const parts = useMemo(() => {
    const words = (query?.words ?? []).filter(Boolean);
    const re = words.length ? new RegExp(`(${words.map(esc).join("|")})`, "giu") : null;
    return splitHashtags(text).flatMap((p, i) => {
      if (p.type === "hashtag") return [{ k: `${i}`, t: p.text, cls: cn("text-emerald-400", query?.tags.includes(p.tag) && "font-semibold") }];
      if (p.type === "mention") return [{ k: `${i}`, t: p.text, cls: cn("text-emerald-400", query?.mentions.includes(p.handle) && "font-semibold") }];
      if (!re) return [{ k: `${i}`, t: p.text, cls: "" }];
      return p.text.split(re).map((s, j) => ({ k: `${i}.${j}`, t: s, cls: j % 2 ? "rounded-[3px] bg-amber-400/25 text-zinc-50" : "" }));
    });
  }, [text, query]);
  return (
    <>
      {parts.map((p) =>
        p.cls ? (
          <mark key={p.k} className={cn("bg-transparent text-inherit", p.cls)}>
            {p.t}
          </mark>
        ) : (
          <span key={p.k}>{p.t}</span>
        ),
      )}
    </>
  );
}

export const HxMessageRow = memo(function HxMessageRow({
  m,
  query,
  onPick,
  active,
  showChat = true,
}: {
  m: HxMessage;
  query?: HxQuery;
  onPick?: (m: HxMessage, e: React.MouseEvent) => void;
  active?: boolean;
  showChat?: boolean;
}) {
  return (
    <Link
      href={m.href}
      prefetch={false}
      onClick={onPick ? (e) => onPick(m, e) : undefined}
      className={cn("flex min-w-0 items-start gap-3 rounded-2xl px-2 py-2.5 hover:bg-white/5 active:bg-white/10", active && "bg-white/10")}
      data-testid="hx-message"
      aria-current={active ? "true" : undefined}
    >
      <Avatar name={(showChat ? m.chat.title : m.from.name) || "?"} color={m.chat.color} photo={showChat ? m.chat.photoUrl : null} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{showChat ? m.chat.title : m.from.me ? "You" : m.from.name}</span>
          <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">{timeAgo(m.at)}</span>
        </div>
        <p className="line-clamp-2 text-[13px] leading-snug text-zinc-400 [overflow-wrap:anywhere]">
          {showChat && (m.from.me || m.chat.kind === "group") && <span className="text-zinc-300">{m.from.me ? "You" : m.from.name}: </span>}
          <Snippet text={m.text} query={query} />
        </p>
      </div>
    </Link>
  );
});

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mt-5" data-testid={`hx-section-${title.toLowerCase()}`}>
      <h2 className="mb-1.5 flex items-center gap-1.5 px-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
        {icon}
        {title}
        {count !== undefined && <span className="text-zinc-600 tabular-nums">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

export function ResultsSkeleton({ loading, rows = 3 }: { loading: boolean; rows?: number }) {
  if (!loading) return <p className="mt-8 px-2 text-center text-sm text-zinc-500">Search is unavailable right now.</p>;
  return (
    <div className="mt-5 space-y-1" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2.5">
          <div className="skeleton h-10 w-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-1/3 rounded" />
            <div className="skeleton h-3 w-3/4 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Suggestions for the token being typed: "#mu" → tags (my use first), "@ma" → people (follows, chats first). */
export function SearchSuggestions({ q, onPick }: { q: string; onPick: (replacement: string) => void }) {
  const tok = typingToken(q);
  const url = tok ? `/hx/suggest?q=${encodeURIComponent((tok.kind === "tag" ? "#" : "@") + tok.prefix)}` : null;
  const { data } = useHx<{ tags?: HxSuggestion[]; people?: HxPerson[] }>(url, 120, 20_000);
  if (!tok || !data) return null;
  const replace = (tokText: string) => onPick(q.replace(/([#@])([^\s#@]*)$/u, tokText) + " ");
  if (tok.kind === "tag") {
    const tags = data.tags ?? [];
    if (!tags.length) return null;
    return (
      <ul className="mt-3 flex flex-wrap gap-2" data-testid="hx-suggestions" aria-label="Hashtag suggestions">
        {tags.map((t) => (
          <li key={t.tag} className="max-w-full">
            <button
              type="button"
              onClick={() => replace(`#${t.tag}`)}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/10 bg-zinc-900 px-3 py-1.5 text-sm text-emerald-400 hover:border-emerald-500/50"
            >
              <Hash className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t.tag}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  const people = data.people ?? [];
  if (!people.length) return null;
  return (
    <ul className="mt-2" data-testid="hx-people-suggestions" aria-label="People">
      {people.map((u) => (
        <li key={u.id}>
          <button type="button" onClick={() => replace(`@${u.username}`)} className="flex w-full min-w-0 items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-white/5">
            <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-semibold">{u.name}</span> <span className="text-zinc-500">@{u.username}</span>
            </span>
            {u.following && <span className="shrink-0 text-[11px] text-zinc-500">Following</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ProfileCard({ u }: { u: HxPerson }) {
  return (
    <div className="mt-4 flex min-w-0 items-center gap-3 rounded-3xl border border-white/10 bg-zinc-900/70 p-3" data-testid="hx-profile">
      <Link href={`/profile/${u.id}`} prefetch={false} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="md" />
        <div className="min-w-0">
          <div className="truncate font-semibold">{u.name}</div>
          <div className="truncate text-xs text-zinc-500">@{u.username}</div>
          {u.bio && <p className="line-clamp-1 text-xs text-zinc-400 [overflow-wrap:anywhere]">{u.bio}</p>}
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-1.5">
        <Link href={`/messages/${u.id}`} prefetch={false} aria-label={`Message ${u.name}`} className="rounded-full border border-white/15 p-2 text-zinc-200 hover:bg-white/5">
          <MessageCircle className="h-4 w-4" />
        </Link>
        <FollowButton userId={u.id} small />
      </div>
    </div>
  );
}

/** Grouped results for the global search page. */
export function GlobalResults({ q }: { q: string }) {
  const { rooms: liveRooms } = useApp();
  const { data, loading } = useHx<HxResults>(searchUrl({ q, scope: "all" }), 200);
  if (!data) return <ResultsSkeleton loading={loading} />;
  const query = data.query;
  // rooms they host or speak in right now (live state) on top of the indexed ones
  const profileIds = new Set(data.profiles.map((p) => p.id));
  const extraRooms = profileIds.size
    ? liveRooms.filter((r) => (profileIds.has(r.hostId) || r.speakers.some((s) => profileIds.has(s.id))) && !data.rooms.some((x) => x.id === r.id))
    : [];
  const rooms = [...data.rooms.map((r) => ({ id: r.id, title: r.title, description: r.description })), ...extraRooms.map((r) => ({ id: r.id, title: r.title, description: r.description }))];
  const empty = !data.messages.length && !rooms.length && !data.people.length && !data.profiles.length;
  return (
    <div data-testid="hx-results">
      {data.profiles.map((u) => (
        <ProfileCard key={u.id} u={u} />
      ))}
      {empty && <p className="mt-8 px-2 text-center text-sm text-zinc-500">No results for “{q.trim()}”.</p>}
      {data.messages.length > 0 && (
        <Section icon={<MessageCircle className="h-3.5 w-3.5" />} title="Messages" count={data.total ?? data.messages.length}>
          {data.messages.map((m) => (
            <HxMessageRow key={m.id} m={m} query={query} />
          ))}
        </Section>
      )}
      {rooms.length > 0 && (
        <Section icon={<Mic className="h-3.5 w-3.5" />} title="Rooms" count={rooms.length}>
          {rooms.map((r) => (
            <Link key={r.id} href={`/room/${r.id}`} prefetch={false} className="flex min-w-0 items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-white/5" data-testid="hx-room">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                <Mic className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    <Snippet text={r.title} query={query} />
                  </span>
                  <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-400 uppercase">Live</span>
                </div>
                {r.description && (
                  <p className="line-clamp-1 text-[13px] text-zinc-400 [overflow-wrap:anywhere]">
                    <Snippet text={r.description} query={query} />
                  </p>
                )}
              </div>
            </Link>
          ))}
        </Section>
      )}
      {data.people.length > 0 && (
        <Section icon={<User className="h-3.5 w-3.5" />} title="People" count={data.people.length}>
          {data.people.map((u) => (
            <Link key={u.id} href={`/profile/${u.id}`} prefetch={false} className="flex min-w-0 items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-white/5" data-testid="hx-person">
              <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{u.name}</div>
                <p className="line-clamp-1 text-[13px] text-zinc-400 [overflow-wrap:anywhere]">
                  <Snippet text={u.bio} query={query} />
                </p>
              </div>
            </Link>
          ))}
        </Section>
      )}
      {query.mentions.length > 0 && !data.profiles.length && (
        <p className="mt-3 flex items-center justify-center gap-1 px-2 text-xs text-zinc-600">
          <AtSign className="h-3 w-3" /> No account with that screen name.
        </p>
      )}
    </div>
  );
}
