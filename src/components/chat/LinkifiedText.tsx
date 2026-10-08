"use client";

import { Fragment, memo, useMemo, useRef } from "react";
import Link from "next/link";
import { linkify, type HashtagToken, type LinkToken, type MentionToken } from "@/lib/linkify";
import { openLinkConfirm } from "./LinkConfirm";
import { openHashtag } from "@/components/search/ChatSearch";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export const LINK_REL = "noopener noreferrer nofollow ugc";

/**
 * Chat text with safe, tappable links (Telegram/WhatsApp style). Rendered as React elements only, never HTML.
 * - openlounge.app pages → in-app navigation (no reload, no browser)
 * - other sites → confirm sheet first (domain, full address, look-alike warnings), then the system browser
 * - mailto:/tel: → handed straight to the OS (through the sheet too if the address looks suspicious)
 * - #hashtags → accent span; tap = in-chat search (inside a conversation) or global search (titles, bios)
 * `links={false}` renders hashtags only (e.g. inside a card that is itself a link).
 */
export const LinkifiedText = memo(function LinkifiedText({ text, tone = "default", links = true }: { text: string; tone?: "default" | "onAccent"; links?: boolean }) {
  const tokens = useMemo(() => linkify(text), [text]);
  if (!tokens.some((t) => t.type !== "text")) return <>{text}</>;
  return (
    <>
      {tokens.map((t, i) =>
        t.type === "text" ? (
          <Fragment key={i}>{t.text}</Fragment>
        ) : t.type === "hashtag" ? (
          <HashtagChip key={i} t={t} tone={tone} />
        ) : t.type === "mention" ? (
          <MentionChip key={i} t={t} tone={tone} />
        ) : links ? (
          <ChatLink key={i} t={t} tone={tone} />
        ) : (
          <Fragment key={i}>{t.text}</Fragment>
        ),
      )}
    </>
  );
});

/** Tappable @screen_name → their profile (/u/<handle>). A span, so it is valid inside cards that are links. */
function MentionChip({ t, tone }: { t: MentionToken; tone: "default" | "onAccent" }) {
  const router = useRouter();
  const go = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    router.push(`/u/${encodeURIComponent(t.handle)}`);
  };
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && go(e)}
      className={cn("cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-1", tone === "onAccent" ? "font-semibold" : "text-emerald-400")}
      data-testid="mention"
      data-handle={t.handle}
    >
      {t.text}
    </span>
  );
}

/** Tappable #tag (a span, so it is valid inside cards that are links themselves). */
function HashtagChip({ t, tone }: { t: HashtagToken; tone: "default" | "onAccent" }) {
  const go = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openHashtag(t.tag);
  };
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && go(e)}
      className={cn(
        "cursor-pointer rounded-sm [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-1",
        tone === "onAccent" ? "font-semibold" : "text-emerald-400",
      )}
      data-testid="hashtag"
      data-tag={t.tag}
    >
      {t.text}
    </span>
  );
}

/** Long-press (touch) or right-click on any link → the link sheet (Copy link / Open), like Telegram. */
function useLinkLongPress(t: LinkToken) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        e.stopPropagation(); // the bubble's own long-press (timestamp/report) must not fire on a link
        fired.current = false;
        if (e.pointerType === "mouse") return;
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          openLinkConfirm(t, { menu: true });
        }, 450);
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        clear();
        if (!fired.current) openLinkConfirm(t, { menu: true });
      },
    },
  };
}

function ChatLink({ t, tone }: { t: LinkToken; tone: "default" | "onAccent" }) {
  const lp = useLinkLongPress(t);
  const cls = cn(
    "rounded-sm underline underline-offset-2 [overflow-wrap:anywhere] [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-offset-1",
    tone === "onAccent" ? "decoration-current/50 hover:decoration-current" : "text-emerald-400 decoration-emerald-400/40 hover:decoration-emerald-400",
  );
  if (t.kind === "internal" && t.path) {
    return (
      <Link
        href={t.path}
        prefetch={false}
        className={cls}
        {...lp.handlers}
        onClick={(e) => {
          if (lp.fired.current) e.preventDefault();
        }}
        data-testid="chat-link"
        data-kind="internal"
      >
        {t.text}
      </Link>
    );
  }
  const direct = (t.kind === "mailto" || t.kind === "tel") && t.warnings.length === 0;
  return (
    <a
      href={t.href}
      {...(t.kind === "external" ? { target: "_blank" } : null)}
      rel={LINK_REL}
      referrerPolicy="no-referrer"
      className={cls}
      {...lp.handlers}
      onClick={(e) => {
        if (lp.fired.current) {
          e.preventDefault();
          return;
        }
        if (direct) return;
        e.preventDefault();
        e.stopPropagation();
        openLinkConfirm(t);
      }}
      data-testid="chat-link"
      data-kind={t.kind}
      data-suspicious={t.warnings.length ? "1" : undefined}
    >
      {t.text}
    </a>
  );
}
