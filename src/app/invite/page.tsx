"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookUser, Check, ChevronLeft, Copy, Loader2, Lock, Share2, ShieldCheck, Trash2 } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Sheet } from "@/components/Sheet";
import { Avatar } from "@/components/Avatar";
import { FollowButton } from "@/components/UserRow";
import { useApp } from "@/components/AppProvider";
import { hasNativeContacts, native, readNativeContacts, shareLink } from "@/lib/native";
import { deleteUploadedContacts, matchContacts, prepareContacts, type ContactEntry } from "@/lib/contacts";
import { getNotifPrefs, setNotifPrefs } from "@/lib/push";
import { bumpInvitesShared, inviteText, invitesShared, profileLink } from "@/lib/links";
import type { PublicUser } from "@/lib/types";

type Phase = "idle" | "explainer" | "loading" | "denied" | "results";

export default function InvitePage() {
  const { me, toast, reportError } = useApp();
  const [count, setCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [canContacts, setCanContacts] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [members, setMembers] = useState<PublicUser[]>([]);
  const [others, setOthers] = useState<ContactEntry[]>([]);
  const [optedIn, setOptedIn] = useState(false);
  const [limited, setLimited] = useState(false);
  const [progress, setProgress] = useState<{ label: string; p: number } | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(100);

  useEffect(() => {
    setCount(invitesShared());
    setCanContacts(hasNativeContacts());
    getNotifPrefs()
      .then((p) => setOptedIn(p.contactsOptIn))
      .catch(() => {});
  }, []);

  const link = me ? profileLink(me.username) : "";

  async function share(text = inviteText(me?.name)) {
    const how = await shareLink(text, link);
    if (how === "failed") return;
    bumpInvitesShared();
    setCount(invitesShared());
    if (how === "copied") toast("Invite link copied");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast(link);
    }
  }

  async function findFriends() {
    setPhase("loading");
    try {
      await setNotifPrefs({ contactsOptIn: true });
      setOptedIn(true);
      const res = await readNativeContacts();
      if (!res) {
        await setNotifPrefs({ contactsOptIn: false });
        setOptedIn(false);
        setPhase("denied");
        return;
      }
      setLimited(res.limited);
      setProgress({ label: "Preparing contacts", p: 0 });
      const entries = await prepareContacts(res.contacts, res.country, (p) => setProgress({ label: "Preparing contacts", p: p * 0.5 }));
      const r = await matchContacts(entries.map((e) => e.hash), (p) => setProgress({ label: "Checking who's here", p: 0.5 + p * 0.5 }));
      const matched = new Set(r.matchedHashes);
      setMembers(r.users);
      setOthers(entries.filter((e) => !matched.has(e.hash)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
      setQuery("");
      setShown(100);
      setProgress(null);
      setPhase("results");
    } catch (e) {
      setProgress(null);
      setPhase("idle");
      reportError(e);
    }
  }

  async function removeContacts() {
    try {
      await deleteUploadedContacts();
      setOptedIn(false);
      setMembers([]);
      setOthers([]);
      setPhase("idle");
      toast("Uploaded contacts deleted");
    } catch (e) {
      reportError(e);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q ? others.filter((c) => c.name.toLowerCase().includes(q) || c.e164.includes(q.replace(/[^\d+]/g, "") || "\u0000")) : others;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-4 pb-24">
        <Link href="/settings" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
          <ChevronLeft className="h-4 w-4" /> Settings
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Invite friends</h1>
        <p className="mt-1 mb-5 text-sm text-zinc-400">Open Lounge is better with your people.</p>

        {/* invite count + share-link card */}
        <section className="mb-6 rounded-3xl border border-white/5 bg-zinc-900/70 p-5">
          <div className="flex items-center gap-4">
            {me && <Avatar name={me.name} color={me.color} photo={me.photoUrl} size="md" />}
            <div className="min-w-0 flex-1">
              <div className="text-3xl font-bold tabular-nums">{count}</div>
              <div className="text-xs text-zinc-500">{count === 1 ? "invite shared" : "invites shared"}</div>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-zinc-800/80 px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-300" data-testid="invite-link">
              {link.replace(/^https:\/\//, "")}
            </span>
            <button onClick={copy} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/5" aria-label="Copy link">
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => share()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3 font-semibold text-on-accent hover:bg-emerald-400">
            <Share2 className="h-4 w-4" /> Share invite link
          </button>
        </section>

        {/* contacts */}
        <section>
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Find friends from contacts</h2>
          {!canContacts ? (
            <div className="rounded-2xl border border-white/5 bg-zinc-900/70 p-4 text-sm text-zinc-400">
              Get the Open Lounge app on your phone to see which contacts are already here. On the web, share your invite link instead.
            </div>
          ) : phase === "results" ? (
            <>
              {limited && (
                <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                  <span className="flex-1">Only the contacts you selected were checked. Allow full access in Settings.</span>
                  {native()?.openAppSettings && (
                    <button onClick={() => native()?.openAppSettings?.()} className="shrink-0 rounded-full border border-amber-200/30 px-3 py-1.5 text-xs font-semibold">Settings</button>
                  )}
                </div>
              )}
              <div className="mb-2 text-sm font-semibold">Friends on Open Lounge {members.length ? `· ${members.length}` : ""}</div>
              <div className="mb-5 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
                {members.length === 0 && <div className="p-4 text-sm text-zinc-500">None of your contacts are here yet — invite them below.</div>}
                {members.map((u, i) => (
                  <Link key={u.id} href={`/profile/${u.id}`} className={"flex items-center gap-3 px-4 py-3 hover:bg-white/5 " + (i ? "border-t border-white/5" : "")}>
                    <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{u.name}</span>
                      <span className="block truncate text-xs text-zinc-500">@{u.username}</span>
                    </span>
                    <FollowButton userId={u.id} small />
                  </Link>
                ))}
              </div>
              {others.length > 0 && (
                <>
                  <div className="mb-2 text-sm font-semibold">Invite · {others.length}</div>
                  <input
                    value={query}
                    onChange={(e) => (setQuery(e.target.value), setShown(100))}
                    placeholder="Search contacts"
                    className="mb-2 w-full rounded-full border border-white/10 bg-zinc-900/70 px-4 py-2 text-sm outline-none focus:border-sky-500"
                  />
                  <div className="mb-2 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
                    {filtered.length === 0 && <div className="p-4 text-sm text-zinc-500">No contacts match “{query}”.</div>}
                    {filtered.slice(0, shown).map((c, i) => (
                      <div key={c.hash} className={"flex items-center gap-3 px-4 py-2.5 " + (i ? "border-t border-white/5" : "")}>
                        <Avatar name={c.name} color="#64748B" size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                        <button
                          onClick={() => share(`Hey ${c.name.split(" ")[0]}! ${inviteText(me?.name)}`)}
                          className="rounded-full border border-white/15 px-3.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/5"
                        >
                          Invite
                        </button>
                      </div>
                    ))}
                  </div>
                  {filtered.length > shown && (
                    <button onClick={() => setShown((n) => n + 200)} className="mb-5 w-full rounded-full border border-white/15 py-2 text-sm font-semibold text-zinc-200 hover:bg-white/5">
                      Show more ({filtered.length - shown} left)
                    </button>
                  )}
                  <div className="mb-3" />
                </>
              )}
              <p className="mb-3 flex items-start gap-2 text-xs text-zinc-500">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Names and numbers stay on this phone. Invites open your share sheet — we never text anyone.
              </p>
            </>
          ) : (
            <div className="rounded-2xl border border-white/5 bg-zinc-900/70 p-4">
              <div className="flex items-start gap-3">
                <BookUser className="mt-0.5 h-5 w-5 text-sky-400" />
                <div className="flex-1 text-sm">
                  <div className="font-medium">See who you know</div>
                  <div className="text-zinc-400">
                    {phase === "denied" ? "Contacts access is off. You can turn it on in your phone's Settings anytime — the app works fine without it." : "Optional. Find contacts who are already here and follow them."}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                {phase === "denied" && native()?.openAppSettings ? (
                  <button onClick={() => native()?.openAppSettings?.()} className="flex-1 rounded-full border border-white/15 py-2.5 text-sm font-semibold">
                    Open Settings
                  </button>
                ) : null}
                <button
                  onClick={() => setPhase("explainer")}
                  disabled={phase === "loading"}
                  className="flex flex-1 items-center justify-center gap-2 rounded-full bg-sky-500 py-2.5 text-sm font-semibold text-on-color hover:bg-sky-400 disabled:opacity-50"
                >
                  {phase === "loading" && <Loader2 className="h-4 w-4 animate-spin" />} Find friends
                </button>
              </div>
              {phase === "loading" && progress && (
                <div className="mt-3" role="progressbar" aria-valuenow={Math.round(progress.p * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="mb-1 text-xs text-zinc-400">{progress.label}… {Math.round(progress.p * 100)}%</div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${progress.p * 100}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}
          {optedIn && (
            <button onClick={removeContacts} className="mt-3 flex items-center gap-2 text-sm text-red-400 hover:underline">
              <Trash2 className="h-4 w-4" /> Delete uploaded contacts
            </button>
          )}
        </section>
      </main>

      {/* pre-permission explainer (shown before the OS prompt) */}
      <Sheet open={phase === "explainer"} onClose={() => setPhase("idle")} title="Find friends from contacts">
        <ul className="space-y-3 text-sm text-zinc-300">
          <li className="flex gap-3">
            <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
            <span>
              <b>Open Lounge collects the phone numbers in your contacts.</b> On this phone, each number is turned into a one-way code (SHA-256 hash) and only those codes are uploaded. Names, emails and photos are never uploaded.
            </span>
          </li>
          <li className="flex gap-3">
            <BookUser className="h-5 w-5 shrink-0 text-sky-400" />
            <span>
              <b>Used only to match and invite.</b> We show which contacts are on Open Lounge, and can let you know when one joins. Never sold, shared, or used for ads.
            </span>
          </li>
          <li className="flex gap-3">
            <Trash2 className="h-5 w-5 shrink-0 text-zinc-400" />
            <span>
              <b>Deleted automatically.</b> Codes for people not on Open Lounge are erased within 24 hours. Delete everything anytime here.
            </span>
          </li>
          <li className="flex gap-3">
            <Lock className="h-5 w-5 shrink-0 text-zinc-400" />
            <span>We never message your contacts. Invites only go out when you tap Invite and pick an app.</span>
          </li>
        </ul>
        <p className="mt-5 text-xs text-zinc-500">Tapping Agree &amp; continue asks your phone for contacts access, then uploads only the codes. Turn it off anytime with Delete uploaded contacts.</p>
        <button onClick={findFriends} className="mt-3 w-full rounded-full bg-sky-500 py-3.5 font-semibold text-on-color hover:bg-sky-400" data-testid="contacts-consent">
          Agree &amp; continue
        </button>
        <button onClick={() => setPhase("idle")} className="mt-2 w-full rounded-full py-3 text-sm text-zinc-400 hover:text-zinc-200">
          Not now
        </button>
        <p className="mt-2 text-center text-xs text-zinc-500">
          <Link href="/privacy/contacts" className="underline">
            How we handle contacts
          </Link>
        </p>
      </Sheet>
    </>
  );
}
