"use client";

import { Check, Moon, Sun } from "lucide-react";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useTheme } from "./ThemeProvider";

const OPTIONS: { value: Theme; label: string; icon: typeof Sun; preview: { bg: string; card: string; line: string; accent: string } }[] = [
  { value: "light", label: "Light", icon: Sun, preview: { bg: "#f4f3ee", card: "#ffffff", line: "#d9d8d2", accent: "#059669" } },
  { value: "dark", label: "Dark", icon: Moon, preview: { bg: "#0b0b0d", card: "#18181b", line: "#3f3f46", accent: "#10b981" } },
];

/** Two big, obvious cards with a mini preview of each layout. */
export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3">
      {OPTIONS.map(({ value, label, icon: Icon, preview }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(value)}
            className={cn(
              "group rounded-3xl border p-2.5 text-left transition",
              active ? "border-emerald-500 ring-2 ring-emerald-500/30" : "border-white/10 hover:border-white/20",
            )}
          >
            {/* mini preview (fixed colors so each card always shows its own theme) */}
            <div className="relative overflow-hidden rounded-2xl p-2.5" style={{ background: preview.bg }} aria-hidden>
              <div className="rounded-xl p-2" style={{ background: preview.card }}>
                <div className="mb-1.5 h-1.5 w-10 rounded-full" style={{ background: preview.accent }} />
                <div className="mb-2 h-2 w-full rounded-full" style={{ background: preview.line }} />
                <div className="flex gap-1">
                  {["#EC4899", "#3B82F6", "#F97316"].map((c) => (
                    <div key={c} className="h-5 w-5 rounded-[38%]" style={{ background: c }} />
                  ))}
                </div>
              </div>
              <div className="mx-auto mt-2 h-3 w-14 rounded-full" style={{ background: preview.accent }} />
            </div>
            <div className="mt-2.5 flex items-center justify-between px-1">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <Icon className="h-4 w-4" /> {label}
              </span>
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border",
                  active ? "border-emerald-500 bg-emerald-500 text-on-accent" : "border-white/20",
                )}
              >
                {active && <Check className="h-3 w-3" />}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
