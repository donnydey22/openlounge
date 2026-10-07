"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, LogOut, MessageCircle, Moon, Sparkles, Sun } from "lucide-react";
import { useApp } from "@/components/AppProvider";
import { TopBar } from "@/components/TopBar";
import { Avatar } from "@/components/Avatar";
import { ThemePicker } from "@/components/ThemePicker";
import { NotificationToggle } from "@/components/NotificationToggle";
import { useTheme } from "@/components/ThemeProvider";
import { Sheet } from "@/components/Sheet";
import { InterestChips } from "@/components/profile/InterestChips";

export default function SettingsPage() {
  const { me, signOut, updateMe, toast, reportError } = useApp();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [interestsOpen, setInterestsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(me?.interests ?? []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (interestsOpen) setSelected(me?.interests ?? []);
  }, [interestsOpen, me?.interests]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-24">
        <h1 className="mb-6 text-2xl font-bold tracking-tight">Settings</h1>

        <section className="mb-8">
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Appearance</h2>
          <p className="mb-3 text-sm text-zinc-400">Choose a white or black layout. Saved on this device.</p>
          <ThemePicker />
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="mt-3 flex w-full items-center justify-between rounded-2xl border border-white/5 bg-zinc-900/70 px-4 py-3 text-sm"
          >
            <span className="flex items-center gap-2">
              {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} Dark mode
            </span>
            <span
              role="switch"
              aria-checked={theme === "dark"}
              className={"relative h-6 w-11 rounded-full transition " + (theme === "dark" ? "bg-emerald-500" : "bg-zinc-700")}
            >
              <span
                className={
                  "absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all " + (theme === "dark" ? "left-[22px]" : "left-0.5")
                }
              />
            </span>
          </button>
          <NotificationToggle />
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Account</h2>
          <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
            {me && (
              <Link href={`/profile/${me.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-white/5">
                <Avatar name={me.name} color={me.color} photo={me.photoUrl} size="sm" online />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{me.name}</div>
                  <div className="truncate text-xs text-zinc-500">
                    @{me.username}
                    {me.phoneMasked ? ` · ${me.phoneMasked}` : ""}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-zinc-500" />
              </Link>
            )}
            <button
              onClick={() => setInterestsOpen(true)}
              className="flex w-full items-center gap-3 border-t border-white/5 px-4 py-3 text-left text-sm hover:bg-white/5"
            >
              <Sparkles className="h-4 w-4 text-zinc-400" />
              <span className="flex-1">
                Interests
                {me?.interests?.length ? (
                  <span className="ml-2 text-xs text-zinc-500">{me.interests.length} selected</span>
                ) : null}
              </span>
              <ChevronRight className="h-4 w-4 text-zinc-500" />
            </button>
            <Link href="/messages" className="flex items-center gap-3 border-t border-white/5 px-4 py-3 text-sm hover:bg-white/5">
              <MessageCircle className="h-4 w-4 text-zinc-400" /> <span className="flex-1">Messages</span>
              <ChevronRight className="h-4 w-4 text-zinc-500" />
            </Link>
            <button
              onClick={() => {
                signOut();
                router.push("/");
              }}
              className="flex w-full items-center gap-3 border-t border-white/5 px-4 py-3 text-left text-sm text-red-400 hover:bg-red-500/10"
            >
              <LogOut className="h-4 w-4" /> Sign out / switch user
            </button>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">About</h2>
          <p className="text-sm leading-relaxed text-zinc-400">
            Open Lounge is a place for live audio conversations. Drop into a room, chat, and message the people you follow.
          </p>
        </section>
      </main>

      <Sheet open={interestsOpen} onClose={() => setInterestsOpen(false)} title="Your interests">
        <p className="mb-4 text-sm text-zinc-400">Same chips as signup — edit anytime. Open Lounge&apos;s own categories.</p>
        <InterestChips selected={selected} onChange={setSelected} />
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await updateMe({ interests: selected });
              toast("Interests updated");
              setInterestsOpen(false);
            } catch (e) {
              reportError(e);
            } finally {
              setBusy(false);
            }
          }}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? "Saving…" : selected.length ? `Save (${selected.length})` : "Clear interests"}
        </button>
      </Sheet>
    </>
  );
}
