"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import type { PublicUser } from "@/lib/types";
import { cn, firstName } from "@/lib/utils";
import { useApp } from "../AppProvider";
import { Avatar } from "../Avatar";

/**
 * Pick people for a group: people you follow first, then everyone else; selected people show as removable chips.
 * Demo bots and blocked accounts are left out (the server enforces block rules too).
 */
export function MemberPicker({
  selected,
  onChange,
  excludeIds,
  max,
}: {
  selected: PublicUser[];
  onChange: (next: PublicUser[]) => void;
  excludeIds?: Set<string>;
  max: number;
}) {
  const { request, me, following, presenceOf } = useApp();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    request<{ users: PublicUser[] }>("users:list")
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]));
  }, [request]);
  const picked = useMemo(() => new Set(selected.map((u) => u.id)), [selected]);
  const needle = q.trim().toLowerCase();
  const list = useMemo(
    () =>
      (users ?? [])
        .filter((u) => u.id !== me?.id && !u.isBot && !u.deleted && !excludeIds?.has(u.id))
        .filter((u) => !needle || u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle))
        .sort((a, b) => Number(following.has(b.id)) - Number(following.has(a.id)) || a.name.localeCompare(b.name)),
    [users, me?.id, excludeIds, needle, following],
  );
  const toggle = (u: PublicUser) => {
    if (picked.has(u.id)) onChange(selected.filter((x) => x.id !== u.id));
    else if (selected.length < max) onChange([...selected, u]);
  };
  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3" data-testid="member-chips">
          {selected.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(u)}
              className="flex max-w-full items-center gap-1.5 rounded-full bg-emerald-500/15 py-1 pr-2.5 pl-1 text-sm text-emerald-300"
              aria-label={`Remove ${u.name}`}
            >
              <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="xs" />
              <span className="truncate">{firstName(u.name)}</span>
              <X className="h-3.5 w-3.5 shrink-0" />
            </button>
          ))}
        </div>
      )}
      <div className="relative px-4 py-3">
        <Search className="pointer-events-none absolute top-1/2 left-8 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people"
          className="w-full rounded-full border border-white/10 bg-zinc-950 py-2.5 pr-4 pl-11 text-base outline-none placeholder:text-zinc-600 focus:border-emerald-500/60 sm:text-[15px]"
          data-testid="member-search"
        />
      </div>
      <ul className="pb-4" data-testid="member-list">
        {users === null &&
          [0, 1, 2, 3].map((i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5" aria-hidden>
              <div className="openlounge-hex h-10 w-10 animate-pulse bg-zinc-800" />
              <div className="h-3 w-32 animate-pulse rounded-full bg-zinc-800" />
            </li>
          ))}
        {list.map((u) => {
          const on = picked.has(u.id);
          const st = presenceOf(u.id);
          return (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => toggle(u)}
                className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-white/5"
                aria-pressed={on}
                data-testid="member-option"
              >
                <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" presence={st === "offline" ? null : st} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{u.name}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {following.has(u.id) ? "Following · " : ""}@{u.username}
                  </span>
                </span>
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                    on ? "border-emerald-500 bg-emerald-500 text-on-accent" : "border-zinc-600",
                  )}
                  aria-hidden
                >
                  {on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
              </button>
            </li>
          );
        })}
        {users !== null && list.length === 0 && <li className="px-4 py-8 text-center text-sm text-zinc-500">{needle ? `No people match “${q}”.` : "No one to add yet."}</li>}
      </ul>
    </div>
  );
}
