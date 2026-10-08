"use client";

import "./emoji/chat-fx.css";
import { createPortal } from "react-dom";

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bold, Check, Code, EyeOff, Italic, Keyboard, Link2, Pencil, SendHorizontal, Smile, Strikethrough, Underline, X } from "lucide-react";
import { toggleStyle, wrapLink, type MdStyle } from "@/lib/format/markdown";
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
  // ---- formatting (Telegram): select text → toolbar above the composer; Ctrl/Cmd+B / I / U, +Shift X / P / M, K = link ----
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [linkMode, setLinkMode] = useState<{ start: number; end: number } | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkErr, setLinkErr] = useState(false);
  const readSel = () => {
    const ta = ref.current;
    if (!ta || document.activeElement !== ta) return setSel(null);
    const a = ta.selectionStart ?? 0;
    const b = ta.selectionEnd ?? 0;
    setSel(a !== b ? { start: a, end: b } : null);
  };
  // native listeners too: React's onSelect misses programmatic / handle-drag selections in some engines
  useEffect(() => {
    const ta = ref.current;
    const on = () => readSel();
    document.addEventListener("selectionchange", on);
    ta?.addEventListener("select", on);
    return () => {
      document.removeEventListener("selectionchange", on);
      ta?.removeEventListener("select", on);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readSel only reads the ref and sets state
  }, []);
  const grow = () => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  };
  const applyEdit = (r: { text: string; start: number; end: number }) => {
    if (r.text.length > CHAT_MAX_LENGTH) return;
    setText(r.text);
    onTyping?.();
    requestAnimationFrame(() => {
      const ta = ref.current;
      if (!ta) return;
      ta.value = r.text;
      ta.focus();
      ta.setSelectionRange(r.start, r.end);
      grow();
      readSel();
    });
  };
  const applyStyle = (style: MdStyle) => {
    const ta = ref.current;
    const a = sel?.start ?? ta?.selectionStart ?? 0;
    const b = sel?.end ?? ta?.selectionEnd ?? 0;
    applyEdit(toggleStyle(text, a, b, style));
  };
  const startLink = () => {
    const ta = ref.current;
    const a = sel?.start ?? ta?.selectionStart ?? 0;
    const b = sel?.end ?? ta?.selectionEnd ?? 0;
    setLinkMode({ start: a, end: b });
    setLinkUrl("");
    setLinkErr(false);
  };
  const saveLink = () => {
    if (!linkMode) return;
    const r = wrapLink(text, linkMode.start, linkMode.end, linkUrl);
    if (!r) return setLinkErr(true);
    setLinkMode(null);
    applyEdit(r);
  };
  const cancelLink = () => {
    const m = linkMode;
    setLinkMode(null);
    requestAnimationFrame(() => {
      const ta = ref.current;
      if (!ta) return;
      ta.focus();
      if (m) ta.setSelectionRange(m.start, m.end);
    });
  };
  const formatKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
    const ta = e.currentTarget;
    if (ta.selectionStart === ta.selectionEnd) return false; // nothing selected: leave the browser's shortcut alone
    const k = e.key.toLowerCase();
    const style: MdStyle | "link" | null = e.shiftKey
      ? k === "x" ? "s" : k === "p" ? "sp" : k === "m" ? "code" : null
      : k === "b" ? "b" : k === "i" ? "i" : k === "u" ? "u" : k === "k" ? "link" : null;
    if (!style) return false;
    e.preventDefault();
    if (style === "link") startLink();
    else applyEdit(toggleStyle(text, ta.selectionStart, ta.selectionEnd, style));
    return true;
  };
  // the bar spans the whole composer row (the "+" / attach / sticker buttons beside the field too), so its seven
  // buttons keep ≥36 px tap targets down to 280 px phones
  const rootRef = useRef<HTMLDivElement>(null);
  const [barBox, setBarBox] = useState<{ left: number; width: number } | null>(null);
  const barOpen = !!(sel || linkMode) && !disabled;
  useLayoutEffect(() => {
    if (!barOpen) return;
    const measure = () => {
      const root = rootRef.current;
      if (!root) return;
      const row = (root.closest("[data-composer-row]") as HTMLElement | null) ?? root;
      const a = root.getBoundingClientRect();
      const b = row.getBoundingClientRect();
      setBarBox({ left: b.left - a.left, width: b.width });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [barOpen]);
  // placeholder that fits the field: "Message Maya…" → "Message…" → "Message" → none, so small phones never show a word cut mid-letter
  // (textarea placeholders can't ellipsize in Chromium); re-checked when the field resizes or web fonts land
  const ph = useFittedPlaceholder(ref, placeholder);
  // the field gets wider when the sticker button steps aside (small phones) → re-measure its height
  const hasText = !!text.trim();
  useEffect(() => {
    const id = requestAnimationFrame(grow);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the field empties / fills
  }, [hasText]);
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
      setSel(null);
      if (ref.current) ref.current.style.height = "";
    }
    if (!panel) ref.current?.focus();
  };

  return (
    <div data-testid="composer" className="relative" ref={rootRef}>
    {barOpen && (
      <div
        className="fmt-bar-in absolute inset-x-0 bottom-full z-30 mb-2 rounded-2xl bg-zinc-900 p-0.5 shadow-lg ring-1 ring-white/10"
        style={barBox ? { left: barBox.left, right: "auto", width: barBox.width } : undefined}
        data-testid="format-bar"
        onPointerDown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}
        onMouseDown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}
      >
        {linkMode ? (
          <form
            noValidate // "example.com" is fine here (safeHref adds https://); the browser's url check would block it
            className="flex items-center gap-1 pl-2"
            onSubmit={(e) => {
              e.preventDefault();
              saveLink();
            }}
          >
            <Link2 className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
            <input
              autoFocus
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={linkUrl}
              onChange={(e) => (setLinkUrl(e.target.value), setLinkErr(false))}
              onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), cancelLink())}
              placeholder={linkErr ? "http(s), mailto: or tel: only" : "Paste a link"}
              aria-label="Link address"
              aria-invalid={linkErr || undefined}
              data-testid="format-link-input"
              className={cn("h-10 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-zinc-500 sm:text-[14px]", linkErr && "text-red-400 placeholder:text-red-400")}
            />
            <button type="submit" aria-label="Add link" data-testid="format-link-save" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-emerald-400 hover:bg-white/5">
              <Check className="h-5 w-5" />
            </button>
            <button type="button" onClick={cancelLink} aria-label="Cancel link" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/5">
              <X className="h-5 w-5" />
            </button>
          </form>
        ) : (
          <div className="flex items-center justify-between" role="toolbar" aria-label="Formatting">
            {FORMAT_BUTTONS.map((f) => (
              <button
                key={f.style}
                type="button"
                title={f.label}
                aria-label={f.label}
                data-testid={`format-${f.style}`}
                onClick={() => (f.style === "link" ? startLink() : applyStyle(f.style))}
                className="flex h-10 max-w-[52px] min-w-0 flex-1 basis-0 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/5 hover:text-white active:bg-white/10"
              >
                <f.Icon className="h-[18px] w-[18px]" strokeWidth={f.style === "b" ? 2.8 : 2} />
              </button>
            ))}
          </div>
        )}
      </div>
    )}
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
      data-has-text={text.trim() ? "1" : undefined}
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
          placeholder={ph}
          enterKeyHint="send"
          onBlur={() => {
            onTypingStop?.();
            setSel(null);
          }}
          onSelect={readSel}
          onKeyUp={readSel}
          onMouseUp={readSel}
          onTouchEnd={() => requestAnimationFrame(readSel)}
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
            if (formatKey(e)) return;
            if (e.key === "Escape" && sel) {
              e.preventDefault();
              e.currentTarget.setSelectionRange(sel.end, sel.end);
              setSel(null);
              return;
            }
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

const FORMAT_BUTTONS: { style: MdStyle | "link"; label: string; Icon: typeof Bold }[] = [
  { style: "b", label: "Bold (Ctrl+B)", Icon: Bold },
  { style: "i", label: "Italic (Ctrl+I)", Icon: Italic },
  { style: "u", label: "Underline (Ctrl+U)", Icon: Underline },
  { style: "s", label: "Strikethrough (Ctrl+Shift+X)", Icon: Strikethrough },
  { style: "sp", label: "Spoiler (Ctrl+Shift+P)", Icon: EyeOff },
  { style: "code", label: "Monospace (Ctrl+Shift+M)", Icon: Code },
  { style: "link", label: "Link (Ctrl+K)", Icon: Link2 },
];

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** First candidate whose text fits the textarea's content box (font from computed style); "" if none does. */
function useFittedPlaceholder(ref: React.RefObject<HTMLTextAreaElement | null>, placeholder: string) {
  const [ph, setPh] = useState(placeholder);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    const cands = [placeholder, "Message…", "Message"].filter((c, i, a) => c && a.indexOf(c) === i);
    const fit = () => {
      try {
        const cs = getComputedStyle(ta);
        const avail = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (!(avail > 0)) return; // hidden / not laid out yet: keep the current text
        if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
        if (!measureCtx) return setPh(placeholder);
        measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        setPh(cands.find((c) => measureCtx!.measureText(c).width <= avail) ?? "");
      } catch {
        setPh(placeholder);
      }
    };
    fit();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(fit);
      ro.observe(ta);
    } else window.addEventListener("resize", fit);
    let live = true;
    document.fonts?.ready?.then(() => live && fit()).catch(() => {});
    return () => {
      live = false;
      ro?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [ref, placeholder]);
  return ph;
}
