"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bold, Italic, List, SendHorizontal, Strikethrough, X } from "lucide-react";
import { CHAT_MAX_LENGTH } from "@/lib/types";
import { toggleBullet, toggleInlineFormat, type InlineFormat } from "@/lib/chatFormatting";
import { cn } from "@/lib/utils";

const MAX_TEXTAREA_HEIGHT = 180;

export type ComposerAction =
  | { kind: "reply"; messageId: string; authorName: string; text: string }
  | { kind: "edit"; messageId: string; text: string };

/** Shared multiline composer for web, Android WebView, and iOS WebView chat. */
export function ChatComposer({
  onSend,
  onTyping,
  placeholder = "Say something…",
  disabled,
  autoFocus,
  compact,
  action,
  onCancelAction,
}: {
  onSend: (text: string, context?: { replyToId?: string; editMessageId?: string }) => Promise<boolean>;
  onTyping?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Slightly denser control sizing for in-room chat; the composer still fills its parent width. */
  compact?: boolean;
  /** Reply/edit mode is owned by the surrounding conversation so either transport can render it consistently. */
  action?: ComposerAction | null;
  onCancelAction?: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const keyboardHelpId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const canSend = text.trim().length > 0 && !disabled && !sending;

  useEffect(() => {
    if (!action) return;
    const nextText = action.kind === "edit" ? action.text : "";
    setText(nextText);
    selection.current = { start: nextText.length, end: nextText.length };
    requestAnimationFrame(() => {
      const field = ref.current;
      if (!field) return;
      resize(field);
      field.focus();
      field.setSelectionRange(nextText.length, nextText.length);
    });
  }, [action?.kind, action?.messageId]); // the same draft text stays intact while the user types

  const cancelAction = () => {
    if (action?.kind === "edit") {
      setText("");
      selection.current = { start: 0, end: 0 };
      if (ref.current) ref.current.style.height = "";
    }
    onCancelAction?.();
    ref.current?.focus();
  };

  const resize = (field: HTMLTextAreaElement) => {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  };

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    const context = action?.kind === "reply" ? { replyToId: action.messageId } : action?.kind === "edit" ? { editMessageId: action.messageId } : undefined;
    const ok = await onSend(text.trim(), context);
    setSending(false);
    if (ok) {
      setText("");
      selection.current = { start: 0, end: 0 };
      if (ref.current) ref.current.style.height = "";
      onCancelAction?.();
    }
    ref.current?.focus();
  };

  const applyEdit = (edit: { value: string; selectionStart: number; selectionEnd: number }) => {
    if (edit.value.length > CHAT_MAX_LENGTH) return;
    setText(edit.value);
    selection.current = { start: edit.selectionStart, end: edit.selectionEnd };
    onTyping?.();
    requestAnimationFrame(() => {
      const field = ref.current;
      if (!field) return;
      resize(field);
      field.focus();
      field.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  };

  const format = (kind: InlineFormat) => {
    const field = ref.current;
    if (!field) return;
    const start = field.selectionStart ?? selection.current.start;
    const end = field.selectionEnd ?? selection.current.end;
    applyEdit(toggleInlineFormat(text, start, end, kind));
  };

  const bullet = () => {
    const field = ref.current;
    if (!field) return;
    applyEdit(toggleBullet(text, field.selectionStart ?? selection.current.start, field.selectionEnd ?? selection.current.end));
  };

  const toolbarButton = (
    label: string,
    title: string,
    icon: React.ReactNode,
    onClick: () => void,
  ) => (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled || sending}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={() => {
        const field = ref.current;
        if (field) selection.current = { start: field.selectionStart, end: field.selectionEnd };
      }}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:opacity-40"
    >
      {icon}
    </button>
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex w-full min-w-0 items-end gap-2"
      data-testid="chat-composer"
    >
      <div className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 focus-within:border-emerald-500/60">
        {action && (
          <div className="flex min-w-0 items-center gap-2 border-b border-white/5 px-3 py-2 text-xs">
            <div className="min-w-0 flex-1 border-l-2 border-emerald-400/80 pl-2">
              <div className="font-semibold text-zinc-300">{action.kind === "edit" ? "Editing message" : `Replying to ${action.authorName}`}</div>
              {action.kind === "reply" && <div className="truncate text-zinc-500">{action.text}</div>}
            </div>
            <button type="button" onClick={cancelAction} className="rounded-full p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Cancel message action">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <textarea
          ref={ref}
          rows={compact ? 1 : 2}
          value={text}
          autoFocus={autoFocus}
          maxLength={CHAT_MAX_LENGTH}
          disabled={disabled}
          placeholder={placeholder}
          enterKeyHint="enter"
          aria-label={placeholder}
          aria-describedby={keyboardHelpId}
          onSelect={(event) => {
            selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
          }}
          onChange={(event) => {
            const field = event.currentTarget;
            setText(field.value);
            selection.current = { start: field.selectionStart, end: field.selectionEnd };
            onTyping?.();
            resize(field);
          }}
          onKeyUp={(event) => {
            selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
          }}
          onKeyDown={(event) => {
            // Enter always inserts a paragraph break (also with Shift). Use the explicit shortcut to send.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          className={cn(
            "block max-h-[180px] min-h-[42px] w-full min-w-0 resize-none overflow-y-auto border-0 bg-transparent px-3.5 pt-3 pb-2 text-[15px] leading-snug text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-50",
            compact && "min-h-[38px] px-3 pt-2.5 text-[14px]",
          )}
        />
        <span id={keyboardHelpId} className="sr-only">
          Press Enter to add a new line. Press Control or Command and Enter to send the message.
        </span>
        <div className="flex min-w-0 items-center gap-0.5 border-t border-white/5 px-2 py-1">
          {toolbarButton("Bold", "Bold", <Bold className="h-4 w-4" />, () => format("bold"))}
          {toolbarButton("Italic", "Italic", <Italic className="h-4 w-4" />, () => format("italic"))}
          {toolbarButton("Strikethrough", "Strikethrough", <Strikethrough className="h-4 w-4" />, () => format("strike"))}
          {toolbarButton("Bulleted list", "Bulleted list", <List className="h-4 w-4" />, bullet)}
          {text.length > CHAT_MAX_LENGTH - 60 && (
            <span className="ml-auto pr-1 text-[10px] text-zinc-500" aria-live="polite">
              {text.length}/{CHAT_MAX_LENGTH}
            </span>
          )}
          <span className="ml-auto hidden whitespace-nowrap pr-1 text-[10px] text-zinc-600 xl:inline">
            Enter for new line · Ctrl/⌘+Enter to send
          </span>
        </div>
      </div>
      <button
        type="submit"
        disabled={!canSend}
        // Keep focus (and the mobile keyboard) in the textarea when tapping send.
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        aria-label="Send message"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full transition",
          compact ? "h-[42px] w-[42px]" : "h-[46px] w-[46px]",
          canSend ? "bg-emerald-500 text-on-accent hover:bg-emerald-400" : "bg-zinc-800 text-zinc-500",
        )}
      >
        <SendHorizontal className="h-[18px] w-[18px]" />
      </button>
    </form>
  );
}
