"use client";

import { createPortal } from "react-dom";

import { lazy, Suspense, useRef, useState } from "react";
import { Keyboard, SendHorizontal, Smile } from "lucide-react";
import { CHAT_MAX_LENGTH } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StickerButton } from "../stickers/StickerButton";
import { useEmojiPanelHeight } from "@/lib/emoji/fit";

// the animated picker (and its catalog) loads only when the panel is first opened
const EmojiPicker = lazy(() => import("./emoji/EmojiPicker").then((m) => ({ default: m.EmojiPicker })));

/** Single-line-feel composer: Enter sends, Shift+Enter adds a newline. */
export function ChatComposer({
  onSend,
  onTyping,
  onTypingStop,
  placeholder = "Say something…",
  disabled,
  autoFocus,
  compact,
  emojiPanel,
  panelHost,
  above,
  idleAction,
  onPasteFiles,
}: {
  onSend: (text: string) => Promise<boolean>;
  onTyping?: () => void;
  /** typing ended: sent, cleared, or the field lost focus */
  onTypingStop?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Pill-shaped, smaller variant used for in-room chat */
  compact?: boolean;
  /** rendered right above the field (e.g. group @mention suggestions); gets the draft and a setter */
  above?: (text: string, setText: (t: string) => void) => React.ReactNode;
  /** show the animated emoji panel button (DMs) */
  emojiPanel?: boolean;
  /** where the emoji panel renders (a full-width slot below the composer row); default: inside the composer */
  panelHost?: HTMLElement | null;
  /** shown instead of the send button while the field is empty (DMs: the voice-note mic, Telegram style) */
  idleAction?: React.ReactNode;
  /** files pasted into the field (screenshots, copied images) */
  onPasteFiles?: (files: File[]) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [panel, setPanel] = useState(false);
  const panelH = useEmojiPanelHeight(!!emojiPanel && panel); // fits landscape phones / follows the keyboard
  const insert = (emoji: string) => {
    const ta = ref.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    const next = (text.slice(0, start) + emoji + text.slice(end)).slice(0, CHAT_MAX_LENGTH);
    setText(next);
    onTyping?.();
    requestAnimationFrame(() => {
      if (!ta) return;
      const pos = Math.min(next.length, start + emoji.length);
      ta.setSelectionRange(pos, pos);
    });
  };
  const canSend = text.trim().length > 0 && !disabled && !sending;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    onTypingStop?.();
    const ok = await onSend(text.trim());
    setSending(false);
    if (ok) {
      setText("");
      if (ref.current) ref.current.style.height = "";
    }
    if (!panel) ref.current?.focus();
  };

  return (
    <div data-testid="composer">
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="relative flex items-end gap-2"
    >
      {/* stickers (Telegram-style panel above the composer); sent through the same onSend path */}
      <StickerButton onSend={onSend} disabled={disabled} compact={compact} />
      <div className="relative min-w-0 flex-1">
        {above && (
          <div className="absolute inset-x-0 bottom-full z-20">
            {above(text, (t) => {
              setText(t);
              ref.current?.focus();
            })}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          maxLength={CHAT_MAX_LENGTH}
          disabled={disabled}
          placeholder={placeholder}
          enterKeyHint="send"
          onBlur={() => onTypingStop?.()}
          onFocus={() => panel && setPanel(false)}
          data-testid="composer-input"
          onPaste={(e) => {
            const files = onPasteFiles ? [...(e.clipboardData?.files ?? [])] : [];
            if (files.length) {
              e.preventDefault();
              onPasteFiles!(files);
            }
          }}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim()) onTyping?.();
            else onTypingStop?.();
            // auto-grow up to ~5 lines
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className={cn(
            "block max-h-[120px] w-full resize-none border border-white/10 bg-zinc-950 px-4 leading-snug outline-none placeholder:text-zinc-600 focus:border-emerald-500/60 disabled:opacity-50",
            compact ? "rounded-[20px] py-2 text-[14px]" : "rounded-2xl py-2.5 text-[16px] sm:text-[15px]",
            emojiPanel && "pr-11",
          )}
        />
        {emojiPanel && (
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              if (panel) {
                setPanel(false);
                ref.current?.focus();
              } else {
                ref.current?.blur(); // the panel replaces the keyboard
                setPanel(true);
              }
            }}
            aria-label={panel ? "Show keyboard" : "Emoji"}
            aria-expanded={panel}
            data-testid="emoji-toggle"
            className="absolute right-1.5 bottom-1 flex h-[34px] w-[34px] items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
          >
            {panel ? <Keyboard className="h-5 w-5" /> : <Smile className="h-5 w-5" />}
          </button>
        )}
        {text.length > CHAT_MAX_LENGTH - 60 && (
          <span className="pointer-events-none absolute right-3 -top-5 text-[10px] text-zinc-500">
            {text.length}/{CHAT_MAX_LENGTH}
          </span>
        )}
      </div>
      {idleAction && !text.trim() && !disabled ? (
        idleAction
      ) : (
      <button
        type="submit"
        disabled={!canSend}
        // keep focus (and the mobile keyboard) in the textarea when tapping send
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        aria-label="Send message"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full transition",
          compact ? "h-[38px] w-[38px]" : "h-[42px] w-[42px]",
          canSend ? "bg-emerald-500 text-on-accent hover:bg-emerald-400" : "bg-zinc-800 text-zinc-500",
        )}
      >
        <SendHorizontal className="h-[18px] w-[18px]" />
      </button>
      )}
    </form>
    {emojiPanel && panel && (() => {
      const el = (
        <div className="emoji-panel-in -mx-3 mt-2 border-t border-white/5 bg-zinc-950" data-testid="emoji-panel">
          <Suspense fallback={<div style={{ height: panelH }} />}>
            <EmojiPicker height={panelH} onPick={insert} />
          </Suspense>
        </div>
      );
      // full-width under the whole composer row (beside-composer buttons like "+" must not squeeze it)
      return panelHost ? createPortal(el, panelHost) : el;
    })()}
    </div>
  );
}
