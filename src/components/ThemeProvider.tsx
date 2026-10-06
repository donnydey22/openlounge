"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { LEGACY_THEME_KEYS, THEME_COLORS, THEME_KEY, type Theme } from "@/lib/theme";

const Ctx = createContext<{ theme: Theme; setTheme(t: Theme): void }>({ theme: "dark", setTheme: () => {} });

export function useTheme() {
  return useContext(Ctx);
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const stored = [THEME_KEY, ...LEGACY_THEME_KEYS].map((k) => localStorage.getItem(k)).find((v) => v !== null) ?? null;
    const t: Theme = stored === "light" ? "light" : "dark";
    setThemeState(t);
    apply(t);
    // keep tabs in sync
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY && (e.newValue === "light" || e.newValue === "dark")) {
        setThemeState(e.newValue);
        apply(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
    apply(t);
  }, []);

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}
