"use client";
// Settings → Storage & data. Device side: media auto-download per network, the device media cache cap (media-only
// LRU) and per-chat "Clear media on this device". Server side: read-only usage per chat and the report-only allowance.
// Nothing here deletes a message, its text, or anything on the server.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, HardDrive, Image as ImageIcon, Loader2, Video } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Switch } from "@/components/Switch";
import { useApp } from "@/components/AppProvider";
import { formatBytes } from "@/lib/media/types";
import { getMediaUsage, type MediaUsage } from "@/lib/media/client";
import { AUTO_DOWNLOAD_EVENT, autoPrefs, currentNetwork, setAutoPref, type AutoKind, type NetKind } from "@/lib/storage/autoDownload";
import { CAP_CHOICES, DEFAULT_CAP, MEDIA_CACHE_EVENT, cacheCap, clearMedia, readIndex, setCacheCap, usageByConv } from "@/lib/storage/mediaCache";
import type { ConversationSummary } from "@/lib/types";

const NETS: { net: NetKind; label: string; hint: string }[] = [
  { net: "wifi", label: "On Wi-Fi", hint: "Also used when the browser can't tell" },
  { net: "cellular", label: "On mobile data", hint: "" },
  { net: "roaming", label: "When roaming", hint: "Phone app only" },
];
const KINDS: { kind: AutoKind; label: string; icon: typeof ImageIcon }[] = [
  { kind: "photo", label: "Photos", icon: ImageIcon },
  { kind: "video", label: "Videos (preload & autoplay)", icon: Video },
];

export default function StorageSettingsPage() {
  const { me, reportError, request } = useApp();
  const [prefs, setPrefs] = useState(autoPrefs);
  const [cap, setCap] = useState(DEFAULT_CAP);
  const [local, setLocal] = useState<Map<string, { bytes: number; items: number }>>(new Map());
  const [server, setServer] = useState<MediaUsage | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [net, setNet] = useState<NetKind>("wifi");
  const [busy, setBusy] = useState<string | null>(null);

  const refreshLocal = useCallback(() => setLocal(usageByConv(readIndex())), []);
  useEffect(() => {
    setPrefs(autoPrefs());
    setCap(cacheCap());
    setNet(currentNetwork());
    refreshLocal();
    const a = () => setPrefs(autoPrefs());
    window.addEventListener(AUTO_DOWNLOAD_EVENT, a);
    window.addEventListener(MEDIA_CACHE_EVENT, refreshLocal);
    return () => {
      window.removeEventListener(AUTO_DOWNLOAD_EVENT, a);
      window.removeEventListener(MEDIA_CACHE_EVENT, refreshLocal);
    };
  }, [refreshLocal]);
  useEffect(() => {
    if (!me) return;
    getMediaUsage().then(setServer).catch(reportError);
    // chat names for the per-chat rows (server inbox list; the device chat cache is held with item 5)
    request<{ conversations: ConversationSummary[] }>("dm:list")
      .then((r) => setNames(Object.fromEntries((r.conversations ?? []).map((c) => [c.peer.id, c.peer.name]))))
      .catch(() => {});
  }, [me, reportError, request]);

  const localTotal = [...local.values()].reduce((n, v) => n + v.bytes, 0);
  const convs = new Set<string>([...local.keys(), ...(server?.chats.map((c) => c.conv) ?? [])]);
  const rows = [...convs]
    .map((conv) => ({ conv, device: local.get(conv)?.bytes ?? 0, items: local.get(conv)?.items ?? 0, server: server?.chats.find((c) => c.conv === conv)?.bytes ?? 0 }))
    .sort((a, b) => b.device + b.server - (a.device + a.server));
  const label = (conv: string) => names[conv] ?? (conv.startsWith("g_") ? "Group chat" : "Chat");

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-4 pb-24" data-testid="storage-settings">
        <Link href="/settings" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
          <ChevronLeft className="h-4 w-4" /> Settings
        </Link>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">Storage &amp; data</h1>
        <p className="mb-6 text-sm text-zinc-400">Your messages are always kept. These settings only change what media this device downloads and keeps.</p>

        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Media auto-download</h2>
          <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
            {NETS.map((n, i) => (
              <div key={n.net} className={"px-4 py-3 " + (i ? "border-t border-white/5" : "")}>
                <div className="mb-2 text-sm font-medium">
                  {n.label}
                  {net === n.net && <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">now</span>}
                  {n.hint && <span className="block text-xs font-normal text-zinc-500">{n.hint}</span>}
                </div>
                {KINDS.map((k) => (
                  <label key={k.kind} className="flex items-center gap-3 py-1.5 text-sm">
                    <k.icon className="h-4 w-4 text-zinc-400" />
                    <span className="flex-1">{k.label}</span>
                    <Switch label={`${k.label} ${n.label}`} on={prefs[n.net][k.kind]} onChange={(v) => setAutoPref(n.net, k.kind, v)} />
                  </label>
                ))}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Off: you see a blurred preview and the size; tap to load. Media you send always loads.</p>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Media on this device</h2>
          <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
            <div className="flex items-center gap-3 px-4 py-3 text-sm">
              <HardDrive className="h-4 w-4 text-zinc-400" />
              <span className="flex-1">
                Cache limit
                <span className="block text-xs text-zinc-500" data-testid="device-media-total">
                  {formatBytes(localTotal)} used · oldest media is removed first when full
                </span>
              </span>
              <select
                aria-label="Cache limit"
                value={cap}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCap(v);
                  void setCacheCap(v);
                }}
                className="rounded-lg bg-zinc-800 px-2 py-1 text-sm"
              >
                {CAP_CHOICES.map((c) => (
                  <option key={c} value={c}>
                    {formatBytes(c)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Chats</h2>
          <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70" data-testid="storage-chats">
            {!server && !rows.length ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
              </div>
            ) : !rows.length ? (
              <p className="px-4 py-4 text-sm text-zinc-500">No media yet.</p>
            ) : (
              rows.map((r, i) => (
                <div key={r.conv} className={"flex items-center gap-3 px-4 py-3 text-sm " + (i ? "border-t border-white/5" : "")}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{label(r.conv)}</span>
                    <span className="block text-xs text-zinc-500">
                      {formatBytes(r.device)} on this device · {formatBytes(r.server)} in the chat
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={!r.device || busy === r.conv}
                    onClick={async () => {
                      setBusy(r.conv);
                      await clearMedia(r.conv).catch(() => 0);
                      refreshLocal();
                      setBusy(null);
                    }}
                    className="shrink-0 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-40"
                  >
                    Clear from device
                  </button>
                </div>
              ))
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Clearing removes downloaded copies from this device only. Messages, text and the media in the chat stay; they download again when you open them.</p>
        </section>

        {server && (
          <section className="mb-6">
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Your media on Open Lounge</h2>
            <div className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70 px-4 py-3 text-sm" data-testid="server-allowance">
              {formatBytes(server.sentBytes)} sent · fair share {formatBytes(server.allowance)}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
