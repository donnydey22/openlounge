"use client";

import { useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { CHAT_MAX_LENGTH } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Single-line-feel composer: Enter sends, Shift+Enter adds a newline. */
export function ChatComposer({
  onSend,
  onTyping,
  placeholder = "Say something…",
  disabled,
  autoFocus,
  compact,
}: {
  onSend: (text: string) => Promise<boolean>;
  onTyping?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Pill-shaped, smaller variant used for in-room chat */
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0 && !disabled && !sending;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await onSend(text.trim());
    setSending(false);
    if (ok) {
      setText("");
      if (ref.current) ref.current.style.height = "";
    }
    ref.current?.focus();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2"
    >
      <div className="relative flex-1">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          maxLength={CHAT_MAX_LENGTH}
          disabled={disabled}
          placeholder={disabled ? "Reconnecting…" : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            onTyping?.();
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
            compact ? "rounded-[20px] py-2 text-[14px]" : "rounded-2xl py-2.5 text-[15px]",
          )}
        />
        {text.length > CHAT_MAX_LENGTH - 60 && (
          <span className="pointer-events-none absolute right-3 -top-5 text-[10px] text-zinc-500">
            {text.length}/{CHAT_MAX_LENGTH}
          </span>
        )}
      </div>
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Send message"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full transition",
          compact ? "h-[38px] w-[38px]" : "h-[42px] w-[42px]",
          canSend ? "bg-emerald-500 text-on-accent hover:bg-emerald-400" : "bg-zinc-800 text-zinc-500",
        )}
      >
        <SendHorizontal className="h-[18px] w-[18px]" />
      </button>
    </form>
  );
}
