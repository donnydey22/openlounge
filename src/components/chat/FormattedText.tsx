"use client";

import "./emoji/chat-fx.css";
import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { parseMarkdown, type MdNode } from "@/lib/format/markdown";
import { linkify, type LinkToken } from "@/lib/linkify";
import { LINK_REL } from "./LinkifiedText";
import { openLinkConfirm } from "./LinkConfirm";
import { cn } from "@/lib/utils";

type Tone = "default" | "onAccent";

/**
 * A chat message with Telegram-style formatting (src/lib/format/markdown.ts), rendered as React elements only — never
 * HTML. Plain runs go through `leaf` (links / #tags / @mentions: LinkifiedText or the group MentionText), so autolinks
 * keep working inside bold, quotes, etc. [text](url) links always show the confirm sheet with the real address first.
 */
export const FormattedText = memo(function FormattedText({
  text,
  leaf,
  tone = "default",
  onCopyCode,
}: {
  text: string;
  leaf: (text: string) => ReactNode;
  tone?: Tone;
  /** tap on `code` / a code block copies it (Telegram) */
  onCopyCode?: (code: string) => void;
}) {
  const nodes = useMemo(() => parseMarkdown(text), [text]);
  if (nodes.length === 1 && nodes[0].t === "text") return <>{leaf(nodes[0].v)}</>;
  return <>{render(nodes, { leaf, tone, onCopyCode, inLink: false })}</>;
});

type Ctx = { leaf: (text: string) => ReactNode; tone: Tone; onCopyCode?: (code: string) => void; inLink: boolean };

function render(nodes: MdNode[], ctx: Ctx): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{ctx.inLink ? n.v : ctx.leaf(n.v)}</Fragment>;
      case "b":
        return (
          <strong key={i} className="font-semibold" data-md="b">
            {render(n.c, ctx)}
          </strong>
        );
      case "i":
        return (
          <em key={i} data-md="i">
            {render(n.c, ctx)}
          </em>
        );
      case "u":
        return (
          <span key={i} className="underline underline-offset-2" data-md="u">
            {render(n.c, ctx)}
          </span>
        );
      case "s":
        return (
          <s key={i} data-md="s">
            {render(n.c, ctx)}
          </s>
        );
      case "sp":
        return <Spoiler key={i}>{render(n.c, ctx)}</Spoiler>;
      case "code":
        return (
          <code
            key={i}
            data-md="code"
            onClick={ctx.onCopyCode ? (e) => (e.stopPropagation(), ctx.onCopyCode!(n.v)) : undefined}
            className={cn("rounded-[5px] px-1 py-px font-mono text-[0.88em] [overflow-wrap:anywhere]", ctx.tone === "onAccent" ? "bg-black/15" : "bg-black/30", ctx.onCopyCode && "cursor-pointer")}
          >
            {n.v}
          </code>
        );
      case "pre":
        return (
          <pre
            key={i}
            data-md="pre"
            onClick={ctx.onCopyCode ? (e) => (e.stopPropagation(), ctx.onCopyCode!(n.v)) : undefined}
            className={cn(
              // wraps instead of scrolling sideways: bubbles never get a horizontal scrollbar (280 px phones up)
              "my-1 block rounded-lg px-2.5 py-2 font-mono text-[13px] leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]",
              ctx.tone === "onAccent" ? "bg-black/15" : "bg-black/30",
              ctx.onCopyCode && "cursor-pointer",
            )}
          >
            {n.lang && <span className="mb-1 block text-[11px] font-semibold opacity-60 select-none">{n.lang}</span>}
            {n.v}
          </pre>
        );
      case "link":
        return ctx.inLink ? (
          <Fragment key={i}>{render(n.c, ctx)}</Fragment>
        ) : (
          <TextLink key={i} href={n.href} tone={ctx.tone}>
            {render(n.c, { ...ctx, inLink: true })}
          </TextLink>
        );
      case "quote":
        return (
          <span
            key={i}
            data-md="quote"
            className={cn("my-1 block rounded-r-md border-l-[3px] py-0.5 pr-2 pl-2", ctx.tone === "onAccent" ? "border-white/70 bg-black/10" : "border-emerald-400 bg-emerald-400/10")}
          >
            {render(n.c, ctx)}
          </span>
        );
    }
  });
}

/** ||spoiler||: hidden under a shimmer until tapped (Telegram); not selectable / copyable while hidden. */
function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      role={open ? undefined : "button"}
      tabIndex={open ? undefined : 0}
      aria-label={open ? undefined : "Spoiler, tap to reveal"}
      data-md="sp"
      data-open={open ? "1" : undefined}
      onClick={(e) => {
        if (open) return;
        e.stopPropagation();
        setOpen(true);
      }}
      onKeyDown={(e) => !open && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(true))}
      className="md-spoiler"
    >
      <span aria-hidden={!open}>{children}</span>
    </span>
  );
}

/** [label](url): the address is checked like autolinks (http/https/mailto/tel only); always confirmed before opening. */
function TextLink({ href, tone, children }: { href: string; tone: Tone; children: ReactNode }) {
  const token = useMemo<LinkToken | null>(() => {
    const target = href.startsWith("mailto:") ? href.slice(7) : href.startsWith("tel:") ? href.slice(4) : href;
    const toks = linkify(target);
    const t = toks.length === 1 && toks[0].type === "link" ? toks[0] : null;
    return t ? { ...t, text: href } : null;
  }, [href]);
  const cls = cn(
    "rounded-sm underline underline-offset-2 [overflow-wrap:anywhere] [-webkit-touch-callout:none]",
    tone === "onAccent" ? "decoration-current/50" : "text-emerald-400 decoration-emerald-400/40",
  );
  if (!token) return <span data-md="link-unsafe">{children}</span>;
  if (token.kind === "internal" && token.path)
    return (
      <Link href={token.path} prefetch={false} className={cls} data-testid="chat-link" data-kind="internal" onPointerDown={(e) => e.stopPropagation()}>
        {children}
      </Link>
    );
  return (
    <a
      href={token.href}
      {...(token.kind === "external" ? { target: "_blank" } : null)}
      rel={LINK_REL}
      referrerPolicy="no-referrer"
      className={cls}
      data-testid="chat-link"
      data-kind={token.kind}
      data-md="link"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openLinkConfirm(token);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openLinkConfirm(token, { menu: true });
      }}
    >
      {children}
    </a>
  );
}
