"use client";

import { createPortal } from "react-dom";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, Keyboard, Pencil, SendHorizontal, Smile, X } from "lucide-react";
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
  editing,
  onEditSave,
  onEditCancel,
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
  /** Telegram-style edit mode: the field holds this message's text; send saves (onEditSave), X / Esc cancels */
  editing?: { id: string; text: string } | null;
  /** save an edit; return false to keep edit mode open (failed) */
  onEditSave?: (text: string) => Promise<boolean>;
  /** leave edit mode (X, Esc, or an empty / unchanged save) */
  onEditCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [panel, setPanel] = useState(false);
  const panelH = useEmojiPanelHeight(!!emojiPanel && panel); // fits landscape phones / follows the keyboard
  // edit mode: park the draft, load the message text, put the caret at the end; restore the draft when it ends
  const draftRef = useRef<string | null>(null);
  const editId = editing?.id ?? null;
  useEffect(() => {
    const ta = ref.current;
    const grow = () => {
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    };
    if (editId && editing) {
      if (draftRef.current === null) draftRef.current = text;
      setText(editing.text);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.value = editing.text; // measure the new text even if React hasn't painted it yet
        grow();
        ta.focus();
        ta.setSelectionRange(editing.text.length, editing.text.length);
      });
    } else if (draftRef.current !== null) {
      const draft = draftRef.current;
      setText(draft);
      draftRef.current = null;
      requestAnimationFrame(() => {
        if (ta) ta.value = draft;
        grow();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the message being edited only
  }, [editId]);
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
  const isEditing = !!editing;
  const canSend = (isEditing || text.trim().length > 0) && !disabled && !sending;

  const submit = async () => {
    if (!canSend) return;
    if (editing) {
      const next = text.trim();
      // empty or unchanged = cancel (never sends an empty edit)
      if (!next || next === editing.text.trim()) return onEditCancel?.();
      setSending(true);
      const ok = (await onEditSave?.(next)) ?? false;
      setSending(false);
      if (ok) onEditCancel?.();
      return;
    }
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
    {editing && (
      <div className="edit-bar-in mb-2 flex items-center gap-2 rounded-xl border-l-2 border-emerald-500 bg-white/[0.04] py-1.5 pr-1 pl-2.5" data-testid="edit-bar">
        <Pencil className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[12px] font-semibold text-emerald-400">Edit message</div>
          <div className="truncate text-[13px] text-zinc-400">{editing.text}</div>
        </div>
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onEditCancel?.()}
          aria-label="Cancel editing"
          data-testid="edit-cancel"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
        >
          <X className="h-[18px] w-[18px]" />
        </button>
      </div>
    )}
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="relative flex items-end gap-2"
    >
      {/* stickers (Telegram-style panel above the composer); sent through the same onSend path */}
      {!isEditing && <StickerButton onSend={onSend} disabled={disabled} compact={compact} />}
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
            if (e.key === "Escape" && editing) {
              e.preventDefault();
              e.stopPropagation();
              onEditCancel?.();
              return;
            }
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
      {idleAction && !isEditing && !text.trim() && !disabled ? (
        idleAction
      ) : (
      <button
        type="submit"
        disabled={!canSend}
        // keep focus (and the mobile keyboard) in the textarea when tapping send
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={isEditing ? "Save edit" : "Send message"}
        data-testid={isEditing ? "edit-save" : undefined}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full transition",
          compact ? "h-[38px] w-[38px]" : "h-[42px] w-[42px]",
          canSend ? "bg-emerald-500 text-on-accent hover:bg-emerald-400" : "bg-zinc-800 text-zinc-500",
        )}
      >
        {isEditing ? <Check className="h-5 w-5" /> : <SendHorizontal className="h-[18px] w-[18px]" />}
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
