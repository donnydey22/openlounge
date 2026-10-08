"use client";
// Restores a Premium member's custom web app icon on load. Does nothing (no requests) unless one was chosen.
import { useEffect } from "react";
import { applyAppIcon, premiumMe, savedAppIcon } from "@/lib/premium/client";

export function MonetBoot() {
  useEffect(() => {
    const id = savedAppIcon();
    if (id === "classic") return;
    applyAppIcon(id);
    const t = setTimeout(() => {
      premiumMe()
        .then((m) => {
          if (!m.active || m.prefs.appIcon !== id) applyAppIcon(m.active ? m.prefs.appIcon : "classic");
        })
        .catch(() => {});
    }, 4000);
    return () => clearTimeout(t);
  }, []);
  return null;
}
