"use client";

import { useEffect } from "react";

/**
 * Background scroll lock for every modal / sheet / drawer / menu.
 *
 * The document itself never scrolls (see AppShell + globals.css `html, body`); the only page-level scroller is the
 * app shell (`[data-app-scroll]`). While anything modal is open we freeze that shell, ref-counted so stacked
 * pop-ups (Report → Block) don't unlock each other. `scrollbar-gutter: stable` on the shell keeps the width
 * identical when the scrollbar is hidden (no layout shift on desktop).
 */
let locks = 0;

function apply(on: boolean) {
  if (typeof document === "undefined") return;
  document.querySelectorAll<HTMLElement>("[data-app-scroll]").forEach((el) => {
    el.style.overflowY = on ? "hidden" : "";
  });
  if (on) document.documentElement.setAttribute("data-scroll-locked", "");
  else document.documentElement.removeAttribute("data-scroll-locked");
}

/** Lock the app's background scroll; returns the unlock function (idempotent). */
export function lockAppScroll(): () => void {
  locks += 1;
  if (locks === 1) apply(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0) apply(false);
  };
}

/** Hook form: locks while `active` is true. */
export function useScrollLock(active: boolean) {
  useEffect(() => (active ? lockAppScroll() : undefined), [active]);
}
