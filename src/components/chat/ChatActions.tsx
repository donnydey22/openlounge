"use client";

// Telegram-style inbox actions for 1:1 chats, for me only (the other person is never affected):
//   Pin / Unpin · Mark as read · Remove chat (deleted accounts) / Delete chat (everyone else)
// "Remove chat" is one action: unpin + mark everything read + hide the thread and its messages from my inbox on all
// my devices (server: store.chatAction "remove"). Opened by long-press (touch), right-click (desktop) or swipe left.
import { useRef, useState } from "react";
import { CheckCheck, Loader2, Pin, PinOff, Trash2 } from "lucide-react";
import { Sheet } from "../Sheet";
import { useApp } from "../AppProvider";
import { friendlyMessage } from "@/lib/errors";

export type ChatAction = "pin" | "unpin" | "read" | "remove";
export interface ChatActionResult {
  ok: boolean;
  peerId: string;
  pinned: boolean;
  hidden: boolean;
  unread: number;
}

export function useChatAction() {
  const { request } = useApp();
  return (peerId: string, action: ChatAction) => request<ChatActionResult>("dm:chat", { peerId, action });
}

/** pinned chats first (most recently pinned on top); everything else keeps its order (recency) */
export function sortPinned<T>(list: T[]): T[] {
  const at = (x: T) => (x as { pinnedAt?: number }).pinnedAt ?? 0;
  return list.some((x) => at(x)) ? [...list].sort((a, b) => at(b) - at(a)) : list;
}

export const removeLabel = (deleted: boolean) => (deleted ? "Remove chat" : "Delete chat");

/** One confirm: unpin + mark read + hide from my inbox. */
export function RemoveChatConfirm({
  peer,
  onClose,
  onRemoved,
}: {
  peer: { id: string; name: string; deleted?: boolean } | null;
  onClose: () => void;
  onRemoved?: (peerId: string) => void;
}) {
  const act = useChatAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!peer) return null;
  const label = removeLabel(!!peer.deleted);
  return (
    <Sheet open={!!peer} onClose={onClose} title={`${label}?`}>
      <p className="text-sm leading-relaxed text-zinc-400" data-testid="remove-chat-text">
        {peer.deleted
          ? "This chat with a deleted account will be removed from your inbox and its messages hidden on all your devices."
          : `Your chat with ${peer.name} and its messages will be removed from your inbox on all your devices. ${peer.name} still keeps their copy.`}{" "}
        This can&apos;t be undone.
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <button
        disabled={busy}
        data-testid="remove-chat-confirm"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await act(peer.id, "remove");
            onRemoved?.(peer.id);
            onClose();
          } catch (e) {
            setError(friendlyMessage(e, "Couldn't remove that chat"));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-red-500 py-3.5 font-semibold text-on-color hover:bg-red-400 disabled:opacity-40"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} {label}
      </button>
      <button onClick={onClose} className="mt-2 w-full rounded-full py-3 text-sm font-medium text-zinc-400 hover:bg-white/5">
        Cancel
      </button>
    </Sheet>
  );
}

/** The long-press / right-click menu for an inbox row. */
export function ChatRowMenu({
  chat,
  onClose,
  onRemove,
  onChanged,
}: {
  chat: { peer: { id: string; name: string; deleted?: boolean }; pinned: boolean; unread: number } | null;
  onClose: () => void;
  onRemove: () => void;
  onChanged: (r: ChatActionResult) => void;
}) {
  const act = useChatAction();
  const { toast } = useApp();
  if (!chat) return null;
  const run = (a: ChatAction) => {
    onClose();
    act(chat.peer.id, a)
      .then((r) => {
        onChanged(r);
        if (a === "pin" || a === "unpin") toast(a === "pin" ? "Chat pinned" : "Chat unpinned");
      })
      .catch((e: unknown) => toast(friendlyMessage(e, "Couldn't update that chat")));
  };
  const item = "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium hover:bg-white/5";
  return (
    <Sheet open={!!chat} onClose={onClose} title={chat.peer.name}>
      <div className="space-y-1" data-testid="chat-row-menu">
        <button type="button" className={item + " text-zinc-100"} onClick={() => run(chat.pinned ? "unpin" : "pin")} data-testid={chat.pinned ? "chat-unpin" : "chat-pin"}>
          {chat.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />} {chat.pinned ? "Unpin" : "Pin"}
        </button>
        {chat.unread > 0 && (
          <button type="button" className={item + " text-zinc-100"} onClick={() => run("read")} data-testid="chat-read">
            <CheckCheck className="h-4 w-4" /> Mark as read
          </button>
        )}
        <button
          type="button"
          className={item + " text-red-400 hover:bg-red-500/10"}
          onClick={() => {
            onClose();
            onRemove();
          }}
          data-testid="chat-remove"
        >
          <Trash2 className="h-4 w-4" /> {removeLabel(!!chat.peer.deleted)}
        </button>
      </div>
    </Sheet>
  );
}

const ACTION_W = 96;

/**
 * Row gestures: long-press (touch, 500 ms without moving) and right-click open the menu; swipe left reveals a red
 * Remove/Delete button. A gesture never also follows the row's link.
 */
export function SwipeRow({ children, onMenu, onRemove, removeText, testId }: { children: React.ReactNode; onMenu: () => void; onRemove: () => void; removeText: string; testId?: string }) {
  const [dx, setDx] = useState(0);
  const [open, setOpen] = useState(false);
  const g = useRef<{ x: number; y: number; t: ReturnType<typeof setTimeout> | null; axis: "x" | "y" | null; fired: boolean; base: number }>({ x: 0, y: 0, t: null, axis: null, fired: false, base: 0 });
  const suppress = useRef(false);
  const clear = () => {
    if (g.current.t) clearTimeout(g.current.t);
    g.current.t = null;
  };
  return (
    <div className="relative overflow-hidden rounded-2xl" data-testid={testId}>
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={() => {
          setOpen(false);
          setDx(0);
          onRemove();
        }}
        className="absolute inset-y-0 right-0 flex items-center justify-center bg-red-500 text-sm font-semibold text-on-color"
        style={{ width: ACTION_W, visibility: dx < 0 ? "visible" : "hidden" }}
        data-testid="chat-swipe-remove"
      >
        <span className="flex flex-col items-center gap-1">
          <Trash2 className="h-4 w-4" />
          {removeText.replace(" chat", "")}
        </span>
      </button>
      <div
        className="relative bg-app"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: g.current.axis === "x" ? "none" : "transform 180ms ease-out", touchAction: "pan-y", WebkitTouchCallout: "none" }}
        onContextMenu={(e) => {
          e.preventDefault();
          clear();
          onMenu();
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          g.current = { x: t.clientX, y: t.clientY, axis: null, fired: false, base: open ? -ACTION_W : 0, t: null };
          g.current.t = setTimeout(() => {
            g.current.fired = true;
            suppress.current = true;
            navigator.vibrate?.(10);
            onMenu();
          }, 500);
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          const mx = t.clientX - g.current.x;
          const my = t.clientY - g.current.y;
          if (Math.abs(mx) > 8 || Math.abs(my) > 8) clear();
          if (!g.current.axis && (Math.abs(mx) > 8 || Math.abs(my) > 8)) g.current.axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
          if (g.current.axis === "x") {
            suppress.current = true;
            setDx(Math.max(-ACTION_W * 1.4, Math.min(0, g.current.base + mx)));
          }
        }}
        onTouchEnd={(e) => {
          clear();
          // the menu opened under the finger: lifting it must not "click" the sheet backdrop (or follow the link)
          if (g.current.fired && e.cancelable) e.preventDefault();
          if (g.current.axis === "x") {
            const reveal = dx < -ACTION_W / 2;
            setOpen(reveal);
            setDx(reveal ? -ACTION_W : 0);
          }
          g.current.axis = null;
          if (suppress.current) setTimeout(() => (suppress.current = false), 350);
        }}
        onTouchCancel={() => {
          clear();
          g.current.axis = null;
          setDx(open ? -ACTION_W : 0);
        }}
        onClickCapture={(e) => {
          // a long-press, a swipe, or a tap on an open row closes it instead of navigating
          if (suppress.current || open) {
            e.preventDefault();
            e.stopPropagation();
            if (open && !suppress.current) {
              setOpen(false);
              setDx(0);
            }
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
