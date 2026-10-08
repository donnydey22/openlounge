// Gesture contract between the album carousel (src/components/media/MediaBubble.tsx) and the chat's swipe-to-reply.
//
// The carousel's scroller carries `data-hscroll="album"`. When a touch/pointer starts inside it, the carousel decides
// who owns the horizontal gesture and writes the answer to `data-hscroll-pass` on the scroller *before* the event
// reaches ancestors' listeners in the bubble phase:
//   "0" → the carousel pages (swipe left/right inside it); swipe-to-reply must not start
//   "1" → the gesture started on a 20px bubble edge, or the carousel is on its last page → reply may start
// React onTouchStart handlers above the carousel already see stopPropagation() for "0". pointerdown is NOT stopped (the
// row's long-press menu must work on albums), so a pointer-based swipe-to-reply — and native listeners — must ask this helper.

/** true when a gesture starting at this event target belongs to an album carousel (don't start swipe-to-reply) */
export function carouselOwnsGesture(target: EventTarget | null): boolean {
  const el = target instanceof Element ? (target.closest("[data-hscroll]") as HTMLElement | null) : null;
  if (!el) return false;
  return el.dataset.hscrollPass !== "1";
}
