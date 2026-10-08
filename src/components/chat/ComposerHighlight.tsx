"use client";

// Live #hashtag / @mention / link colouring for a plain <textarea> (no contenteditable): a pixel-aligned mirror layer
// on top of the field paints only the matched tokens in the accent colour over the textarea's own glyphs; everything
// else in the mirror is transparent, so caret, selection, IME, autocorrect and native editing stay 100% native.
// Usage (inside the textarea's `relative` wrapper, after the textarea):
//   <ComposerHighlight text={text} target={ref} className="<same padding / font-size / line-height / border-width>" />
import { memo, useEffect, useMemo, useRef } from "react";
import { linkify } from "@/lib/linkify";
import { cn } from "@/lib/utils";

export const ComposerHighlight = memo(function ComposerHighlight({
  text,
  target,
  className,
}: {
  text: string;
  target: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const tokens = useMemo(() => (/[#@.:]/.test(text) ? linkify(text) : null), [text]);

  // follow the textarea's internal scroll (it scrolls past ~5 lines)
  useEffect(() => {
    const ta = target.current;
    const el = layer.current;
    if (!ta || !el) return;
    const sync = () => {
      el.scrollTop = ta.scrollTop;
    };
    sync();
    ta.addEventListener("scroll", sync, { passive: true });
    return () => ta.removeEventListener("scroll", sync);
  }, [target, text]);

  if (!tokens || !tokens.some((t) => t.type !== "text")) return null;
  return (
    <div
      ref={layer}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden border border-transparent break-words whitespace-pre-wrap text-transparent [overflow-wrap:anywhere]",
        className,
      )}
      data-testid="composer-highlight"
    >
      {tokens.map((t, i) =>
        t.type === "text" ? (
          <span key={i}>{t.text}</span>
        ) : (
          <span key={i} className="text-emerald-400">
            {t.text}
          </span>
        ),
      )}
      {/* keep a trailing newline's height identical to the textarea */}
      {text.endsWith("\n") ? " " : null}
    </div>
  );
});
