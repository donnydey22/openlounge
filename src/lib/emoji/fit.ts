"use client";
// Fit-to-screen helpers for the emoji panel, reaction bar and "+" picker: the visible viewport (keyboard aware via
// visualViewport) and the device safe-area insets (notch / home indicator / landscape side insets).
import { useEffect, useState } from "react";

export type Insets = { top: number; right: number; bottom: number; left: number };

let probe: HTMLDivElement | null = null;
/** env(safe-area-inset-*) in px (0 where unsupported). Cheap: one hidden probe element, read on demand. */
export function safeInsets(): Insets {
  if (typeof document === "undefined") return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

/** the visible area (shrinks with the on-screen keyboard where visualViewport exists) */
export function visibleViewport() {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const w = typeof window !== "undefined" ? window.innerWidth : 390;
  const h = typeof window !== "undefined" ? window.innerHeight : 844;
  return { width: Math.min(w, vv?.width ?? w), height: Math.min(h, vv?.height ?? h), top: vv?.offsetTop ?? 0 };
}

/**
 * Height of the composer's emoji panel: about the keyboard's share of the screen (42 %), never so tall that the
 * thread disappears (landscape phones) and never so small the grid is useless. Tall tablets get a bit more.
 */
export function emojiPanelHeight(vh: number) {
  const max = vh >= 1000 ? 360 : 300;
  return Math.round(Math.max(150, Math.min(max, vh * 0.42)));
}

export function useEmojiPanelHeight(active: boolean) {
  const [h, setH] = useState(() => emojiPanelHeight(visibleViewport().height));
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setH(emojiPanelHeight(visibleViewport().height)));
    };
    on();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", on);
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => {
      cancelAnimationFrame(raf);
      vv?.removeEventListener("resize", on);
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
    };
  }, [active]);
  return h;
}
