"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, Moon } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Switch } from "@/components/Switch";
import { useApp } from "@/components/AppProvider";
import { getNotifPrefs, setNotifPrefs } from "@/lib/push";
import { nativePlatform } from "@/lib/native";
import type { NotifPrefsClient } from "@/lib/types";

type Key = Exclude<keyof NotifPrefsClient, "quietHours" | "contactsOptIn" | "contactsKeep">;
const GROUPS: { title: string; items: { key: Key; label: string; hint: string }[] }[] = [
  {
    title: "Rooms",
    items: [
      { key: "roomInvite", label: "Pings & speaker invites", hint: "Someone pings you into a room or invites you to speak" },
      { key: "followedRoom", label: "People you follow", hint: "Someone you follow starts or joins a room" },
      { key: "trendingRoom", label: "Popular rooms", hint: "Several people you follow are in the same room" },
      { key: "scheduledRoom", label: "Scheduled rooms", hint: "A room you RSVP'd to is starting" },
      { key: "recentRoom", label: "Live again", hint: "A host whose room you were in recently goes live" },
    ],
  },
  { title: "Messages", items: [{ key: "dm", label: "Direct messages", hint: "When you're not in the app" }] },
  {
    title: "People",
    items: [
      { key: "newFollower", label: "New followers", hint: "Grouped so you don't get one per follow" },
      { key: "contactJoined", label: "Friends joining", hint: "A contact just joined Open Lounge (needs Find friends in Invite friends)" },
      { key: "hallwayPresence", label: "Hallway presence", hint: "Someone you follow opens the app" },
    ],
  },
];

export default function NotificationSettingsPage() {
  const { reportError } = useApp();
  const [prefs, setPrefs] = useState<NotifPrefsClient | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getNotifPrefs().then(setPrefs).catch(reportError);
  }, [reportError]);

  async function patch(p: Partial<NotifPrefsClient>) {
    if (!prefs) return;
    const prev = prefs;
    setPrefs({ ...prefs, ...p });
    setSaving(true);
    try {
      setPrefs(await setNotifPrefs(p));
    } catch (e) {
      setPrefs(prev);
      reportError(e);
    } finally {
      setSaving(false);
    }
  }

  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const quiet = prefs?.quietHours ?? null;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-4 pb-24">
        <Link href="/settings" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
          <ChevronLeft className="h-4 w-4" /> Settings
        </Link>
        <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold tracking-tight">
          Notifications {saving && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
        </h1>
        <p className="mb-6 text-sm text-zinc-400">
          {nativePlatform() ? "Push notifications on this phone." : "Push notifications go to the Open Lounge app on your phone."} We group and limit them so you're never spammed.
        </p>
        {!prefs ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
          </div>
        ) : (
          <>
            {GROUPS.map((g) => (
              <section key={g.title} className="mb-6">
                <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{g.title}</h2>
                <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
                  {g.items.map((it, i) => (
                    <label key={it.key} className={"flex items-center gap-3 px-4 py-3 " + (i ? "border-t border-white/5" : "")}>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{it.label}</span>
                        <span className="block text-xs text-zinc-500">{it.hint}</span>
                      </span>
                      <Switch label={it.label} on={prefs[it.key]} onChange={(v) => patch({ [it.key]: v })} />
                    </label>
                  ))}
                </div>
              </section>
            ))}
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Quiet hours</h2>
              <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
                <div className="flex items-center gap-3 px-4 py-3">
                  <Moon className="h-4 w-4 text-zinc-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">Pause room & people alerts</span>
                    <span className="block text-xs text-zinc-500">Messages and pings still come through</span>
                  </span>
                  <Switch label="Quiet hours" on={!!quiet} onChange={(v) => patch({ quietHours: v ? { start: "22:00", end: "08:00", tz } : null })} />
                </div>
                {quiet && (
                  <div className="flex items-center gap-3 border-t border-white/5 px-4 py-3 text-sm">
                    <span className="text-zinc-400">From</span>
                    <input type="time" value={quiet.start} onChange={(e) => patch({ quietHours: { ...quiet, start: e.target.value } })} className="rounded-lg bg-zinc-800 px-2 py-1" />
                    <span className="text-zinc-400">to</span>
                    <input type="time" value={quiet.end} onChange={(e) => patch({ quietHours: { ...quiet, end: e.target.value } })} className="rounded-lg bg-zinc-800 px-2 py-1" />
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
