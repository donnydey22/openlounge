"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Telegram/WhatsApp-style fixed app shell.
 *
 * - The document never scrolls, pans or bounces: <html>/<body> are overflow-clipped and fixed to the viewport
 *   (globals.css). Everything scrolls inside this one element (plus the inner regions pages already have:
 *   DM thread, room chat, sheet bodies), with momentum scrolling and `overscroll-behavior: contain`.
 * - Keyboard: when the on-screen keyboard shrinks the *visual* viewport (iOS Safari / WKWebView overlay mode), the
 *   shell is pinned to exactly the visible area (--ol-vvh / --ol-vv-top, also used by overlays) and any
 *   document scroll iOS adds is undone, so headers and composers stay put; the focused field is scrolled into view
 *   inside the shell. Android WebView (adjustResize) simply shrinks innerHeight, which 100dvh already follows.
 * - Horizontal: scrollLeft is held at 0 (nothing can drift sideways even if a child overflows).
 * - Navigation: new pages start at the top; browser back/forward restores the previous position.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname() ?? "/";
  const positions = useRef(new Map<string, number>());
  const keyRef = useRef<string>("");
  const popped = useRef(false);

  // visual viewport (keyboard) + document scroll guard
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let raf = 0;
    let kbOpen = false;
    const resetDoc = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    };
    const apply = () => {
      raf = 0;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      const open = window.innerHeight - h > 80; // keyboard (or a big bottom bar) covers part of the layout viewport
      if (open) {
        root.style.setProperty("--ol-vvh", `${Math.round(h)}px`);
        root.style.setProperty("--ol-vv-top", `${Math.round(top)}px`);
        root.setAttribute("data-kbd", "");
      } else {
        root.style.removeProperty("--ol-vvh");
        root.style.removeProperty("--ol-vv-top");
        root.removeAttribute("data-kbd");
      }
      if (open && !kbOpen) {
        // keep the focused field visible inside the (now shorter) shell, without a page jump
        const a = document.activeElement as HTMLElement | null;
        if (a && ref.current?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) a.scrollIntoView({ block: "nearest" });
      }
      if (!open && kbOpen) resetDoc(); // iOS sometimes leaves the page shifted after the keyboard closes
      kbOpen = open;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    apply();
    vv?.addEventListener("resize", schedule, { passive: true });
    vv?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    const onWinScroll = () => {
      // the document has nothing to scroll; any offset is iOS keyboard panning or a stray scrollIntoView
      if (!kbOpen) resetDoc();
    };
    window.addEventListener("scroll", onWinScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onWinScroll);
    };
  }, []);

  // horizontal guard + remember the position per page (for back/forward)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollLeft) el.scrollLeft = 0;
      if (keyRef.current) positions.current.set(keyRef.current, el.scrollTop);
    };
    const onPop = () => {
      popped.current = true;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPop);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const key = pathname + window.location.search;
    const prevKey = keyRef.current;
    keyRef.current = key;
    if (!prevKey) return; // first load: browser default
    const target = popped.current ? positions.current.get(key) ?? 0 : 0;
    popped.current = false;
    if (window.location.hash) return; // in-page anchors scroll themselves
    el.scrollTop = target;
    // content that loads a beat later (lists) → try once more
    const raf = requestAnimationFrame(() => {
      if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  return (
    <div ref={ref} id="app-scroll" data-app-scroll className="app-shell">
      {children}
    </div>
  );
}
