// WhatsApp/Telegram-style composer cap + jump-to-latest maths (pure, unit-tested in tests/chat/composerJump.test.ts).

/** Max composer lines before it scrolls internally. */
export const COMPOSER_MAX_LINES = 6;
/** On short screens the composer never takes more than this share of the visible viewport. */
export const COMPOSER_MAX_VIEWPORT_SHARE = 0.4;

/** Pixel cap for the composer: ~6 lines, or 40% of the visible viewport (keyboard-aware), whichever is smaller. */
export function composerMaxHeight(lineHeightPx: number, paddingYPx: number, viewportHeightPx: number): number {
  const lines = Math.round(lineHeightPx * COMPOSER_MAX_LINES + paddingYPx);
  const share = Math.floor(viewportHeightPx * COMPOSER_MAX_VIEWPORT_SHARE);
  const floor = Math.round(lineHeightPx * 2 + paddingYPx); // always at least 2 lines tall
  return Math.max(floor, Math.min(lines, share > 0 ? share : lines));
}

/** Distance (px) from the bottom of a scroller. */
export const distanceFromBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) =>
  Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);

/** The jump button appears once the user is more than ~one screen up from the newest message (or has unseen new ones). */
export function showJumpButton(distancePx: number, clientHeightPx: number, unseen: number): boolean {
  if (distancePx < 80) return false;
  return unseen > 0 || distancePx > clientHeightPx;
}

/** Instant when very far (like WhatsApp), smooth otherwise. Far = more than 3 screens. */
export function jumpPlan(distancePx: number, clientHeightPx: number): { preJumpTo: "near" | null; behavior: ScrollBehavior } {
  if (distancePx > clientHeightPx * 3) return { preJumpTo: "near", behavior: "smooth" };
  return { preJumpTo: null, behavior: "smooth" };
}

/** Badge text: 1..99, then 99+. */
export const badgeText = (n: number) => (n <= 0 ? "" : n > 99 ? "99+" : String(n));

/** Smooth-scroll a chat list to its newest message; very far → snap to one screen above the end, then glide the last bit. */
export function scrollToLatest(el: HTMLElement | null) {
  if (!el) return;
  const d = distanceFromBottom(el);
  const plan = jumpPlan(d, el.clientHeight);
  if (plan.preJumpTo === "near") el.scrollTop = el.scrollHeight - el.clientHeight * 2;
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if ("scrollTo" in el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : plan.behavior });
  else (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
}
