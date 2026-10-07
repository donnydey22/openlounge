"use client";

import { SocialLinkChips } from "@/components/profile/SocialLinks";
import { friendlyMessage, isTransient } from "@/lib/errors";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CalendarDays, Camera, Loader2, LogOut, MessageCircle, Pencil, Radio, Settings, Sparkles } from "lucide-react";
import { fileToAvatarDataUrl } from "@/lib/image";
import { AVATAR_COLORS, type UserProfile } from "@/lib/types";
import { cn, compact } from "@/lib/utils";
import { useApp } from "@/components/AppProvider";
import { TopBar } from "@/components/TopBar";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/components/Sheet";
import { FollowButton, UserRow } from "@/components/UserRow";
import { InterestChips } from "@/components/profile/InterestChips";
import { usePresence } from "@/hooks/usePresence";

/**
 * Profile page — intentionally Clubhouse-clean (precise spacing, soft hex avatar,
 * name/handle/bio/counts/interests). Other screens keep Open Lounge's own chrome.
 */
export default function ProfilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, request, following, signOut, updateMe, setPhoto, toast, reportError } = useApp();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<"followers" | "following" | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingInterests, setEditingInterests] = useState(false);
  const isMe = me?.id === id;
  // live presence (pushed over the WebSocket) — not frozen at the time the profile was fetched
  const presence = usePresence(id, profile?.user.lastSeenAt);

  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    request<{ profile: UserProfile }>("user:get", { userId: id })
      .then((r) => setProfile(r.profile))
      .catch((e: Error) => {
        // connection trouble: keep the skeleton and retry quietly
        if (isTransient(e)) timer = setTimeout(() => setLoadAttempt((n) => n + 1), 2_000);
        else setError(friendlyMessage(e, "This profile isn't available."));
      });
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [id, request, following, me, loadAttempt]);

  if (error) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-lg px-5 py-16 text-center text-zinc-400">
          <div className="mb-2 text-4xl">🔍</div>
          {error}
          <div className="mt-4">
            <Link href="/" className="text-emerald-400 hover:underline">
              Back to the hallway
            </Link>
          </div>
        </main>
      </>
    );
  }

  if (!profile) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-2xl px-4 pt-8" aria-busy="true">
          <div className="skeleton h-24 w-24 rounded-[2rem]" />
          <div className="skeleton mt-5 h-6 w-48 rounded-lg" />
          <div className="skeleton mt-3 h-4 w-32 rounded-lg" />
          <div className="skeleton mt-6 h-16 w-full rounded-2xl" />
        </main>
      </>
    );
  }

  const u = profile.user;
  const online = presence.online;
  const shown = list === "followers" ? profile.followers : list === "following" ? profile.following : [];
  const mockExtra =
    list === "followers" ? u.followers - profile.followers.length : list === "following" ? u.following - profile.following.length : 0;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-lg px-5 pt-10 pb-28 fade-in">
        {/* Clubhouse-like header: avatar left, actions right */}
        <div className="flex items-start justify-between gap-4">
          <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="profile" presence={u.isBot ? null : presence.dot} />
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {isMe ? (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="rounded-full border border-white/12 bg-transparent px-4 py-2 text-[13px] font-semibold tracking-wide hover:bg-white/5"
                >
                  Edit profile
                </button>
                <Link
                  href="/settings"
                  className="rounded-full border border-white/12 p-2.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                  aria-label="Settings"
                >
                  <Settings className="h-4 w-4" />
                </Link>
              </>
            ) : (
              <>
                <FollowButton userId={u.id} />
                <Link
                  href={`/messages/${u.id}`}
                  className="rounded-full border border-white/12 p-2.5 text-zinc-300 hover:bg-white/5"
                  aria-label="Message"
                >
                  <MessageCircle className="h-4 w-4" />
                </Link>
              </>
            )}
          </div>
        </div>

        <div className="mt-5">
          <h1 className="line-clamp-3 text-[26px] leading-tight font-bold tracking-tight [overflow-wrap:anywhere]">{u.name}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[15px] text-zinc-400">
            <span className="max-w-full truncate">@{u.username}</span>
            {online && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide text-emerald-400 uppercase">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online
              </span>
            )}
            {!online && !u.isBot && presence.label && <span className="text-[12px] text-zinc-500">{presence.label}</span>}
            {u.isBot && <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[11px] text-zinc-400">Demo</span>}
          </div>
        </div>

        <div className="mt-4 flex items-baseline gap-5">
          <button onClick={() => setList("followers")} className="text-left hover:opacity-80">
            <span className="text-[17px] font-bold tabular-nums">{compact(u.followers)}</span>{" "}
            <span className="text-[14px] text-zinc-400">{u.followers === 1 ? "follower" : "followers"}</span>
          </button>
          <button onClick={() => setList("following")} className="text-left hover:opacity-80">
            <span className="text-[17px] font-bold tabular-nums">{compact(u.following)}</span>{" "}
            <span className="text-[14px] text-zinc-400">following</span>
          </button>
        </div>

        <p className="mt-4 max-w-prose text-[15px] leading-relaxed whitespace-pre-wrap text-zinc-300 [overflow-wrap:anywhere]">
          {u.bio || (
            <span className="text-zinc-600">{isMe ? "Add a bio so people know who you are." : "No bio yet."}</span>
          )}
        </p>

        <div className="mt-2 flex items-center gap-1.5 text-[13px] text-zinc-500">
          <CalendarDays className="h-3.5 w-3.5" />
          Joined {new Date(u.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
        </div>

        {/* Interests */}
        <section className="mt-7">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-wide text-zinc-500 uppercase">Interests</h2>
            {isMe && (
              <button
                onClick={() => setEditingInterests(true)}
                className="flex items-center gap-1 text-[13px] font-semibold text-sky-400 hover:underline"
              >
                <Pencil className="h-3 w-3" /> Edit
              </button>
            )}
          </div>
          {u.interests?.length ? (
            <InterestChips selected={u.interests} readOnly />
          ) : (
            <p className="text-sm text-zinc-600">
              {isMe ? (
                <button onClick={() => setEditingInterests(true)} className="text-sky-400 hover:underline">
                  Add interests so others know what you&apos;re into
                </button>
              ) : (
                "No interests listed."
              )}
            </p>
          )}
        </section>

        <SocialLinkChips links={u.socialLinks} />

        {profile.currentRoom && (
          <Link
            href={`/room/${profile.currentRoom.id}`}
            className="mt-8 flex items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3.5 hover:bg-emerald-500/10"
          >
            <Radio className="h-5 w-5 shrink-0 text-emerald-400" />
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-wide text-emerald-400/90 uppercase">
                {isMe ? "You're in a room" : "In a room"}
              </div>
              <div className="truncate text-[15px] font-medium">{profile.currentRoom.title}</div>
            </div>
          </Link>
        )}

        {isMe && (
          <button
            onClick={() => {
              signOut();
              router.push("/");
            }}
            className="mt-10 flex items-center gap-2 text-sm text-zinc-500 hover:text-red-300"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        )}
      </main>

      <Sheet open={!!list} onClose={() => setList(null)} title={list === "followers" ? "Followers" : "Following"}>
        <div className="space-y-1">
          {shown.map((x) => (
            <UserRow key={x.id} user={x} />
          ))}
          {shown.length === 0 && <p className="py-4 text-center text-sm text-zinc-500">Nobody here yet.</p>}
          {mockExtra > 0 && (
            <p className="pt-3 text-center text-xs text-zinc-600">+ {compact(mockExtra)} more (demo follower counts are simulated)</p>
          )}
        </div>
      </Sheet>

      {isMe && me && (
        <>
          <EditProfileSheet
            open={editing}
            onClose={() => setEditing(false)}
            initial={{ name: me.name, bio: me.bio, color: me.color, username: me.username, photo: me.photoUrl }}
            onSave={async ({ photo, ...patch }) => {
              try {
                await updateMe(patch);
                if (photo !== undefined) await setPhoto(photo);
                toast("Profile updated");
                setEditing(false);
              } catch (e) {
                reportError(e);
              }
            }}
          />
          <EditInterestsSheet
            open={editingInterests}
            onClose={() => setEditingInterests(false)}
            initial={me.interests ?? []}
            onSave={async (interests) => {
              try {
                await updateMe({ interests });
                toast("Interests updated");
                setEditingInterests(false);
              } catch (e) {
                reportError(e);
              }
            }}
          />
        </>
      )}
    </>
  );
}

function EditInterestsSheet({
  open,
  onClose,
  initial,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  initial: string[];
  onSave: (interests: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setSelected(initial);
  }, [open, initial]);

  return (
    <Sheet open={open} onClose={onClose} title="Your interests">
      <p className="mb-4 text-sm text-zinc-400">Pick what you like hanging out about. You can change these anytime.</p>
      <InterestChips selected={selected} onChange={setSelected} />
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onSave(selected);
          setBusy(false);
        }}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {busy ? "Saving…" : selected.length ? `Save (${selected.length})` : "Clear interests"}
      </button>
    </Sheet>
  );
}

function EditProfileSheet({
  open,
  onClose,
  initial,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  initial: { name: string; bio: string; color: string; username: string; photo: string | null };
  onSave: (p: { name: string; bio: string; color: string; username: string; photo?: string | null }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [bio, setBio] = useState(initial.bio);
  const [color, setColor] = useState(initial.color);
  const [username, setUsername] = useState(initial.username);
  const [photo, setPhotoState] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setName(initial.name);
      setBio(initial.bio);
      setColor(initial.color);
      setUsername(initial.username);
      setPhotoState(undefined);
    }
  }, [open, initial.name, initial.bio, initial.color, initial.username]);
  const shownPhoto = photo === undefined ? initial.photo : photo;

  return (
    <Sheet open={open} onClose={onClose} title="Edit profile">
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim().length < 2 || busy) return;
          setBusy(true);
          await onSave({ name, bio, color, username, ...(photo !== undefined ? { photo } : {}) });
          setBusy(false);
        }}
      >
        <div className="flex flex-col items-center gap-2">
          <button type="button" onClick={() => fileRef.current?.click()} className="relative" aria-label="Change photo">
            <Avatar name={name || "?"} color={color} photo={shownPhoto} size="lg" />
            <span className="absolute -right-1 -bottom-1 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-on-accent ring-2 ring-zinc-900">
              <Camera className="h-3.5 w-3.5" />
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setPhotoState(await fileToAvatarDataUrl(f).catch(() => undefined));
            }}
          />
          {shownPhoto && (
            <button type="button" onClick={() => setPhotoState(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
              Remove photo
            </button>
          )}
        </div>
        <div className="grid grid-cols-10 gap-2">
          {AVATAR_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setColor(c)}
              className={cn("openlounge-hex aspect-square", color === c ? "ring-2 ring-white ring-offset-2 ring-offset-zinc-900" : "opacity-70 hover:opacity-100")}
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-zinc-300">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={48}
            className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 outline-none focus:border-emerald-500/60"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-zinc-300">Username</span>
          <div className="flex items-center rounded-2xl border border-white/10 bg-zinc-950 px-4 focus-within:border-emerald-500/60">
            <span className="text-zinc-500">@</span>
            <input
              value={username}
              autoCapitalize="none"
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
              className="min-w-0 flex-1 bg-transparent px-1 py-3 outline-none"
            />
          </div>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-zinc-300">Bio</span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={280}
            rows={4}
            placeholder="What are you into?"
            className="w-full resize-none rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
          />
          <span className="mt-1 block text-right text-xs text-zinc-600">{bio.length}/280</span>
        </label>
        <div className="sticky -bottom-8 z-10 -mx-5 bg-gradient-to-t from-zinc-900 via-zinc-900 to-transparent px-5 pt-4 pb-2">
          <button disabled={name.trim().length < 2 || busy} className="w-full rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
