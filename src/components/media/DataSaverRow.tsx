"use client";
// Settings row: Data saver (Auto / On / Off). Shared switch in src/lib/dataSaver.ts (chat media; calls can read it).
import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { DATA_SAVER_EVENT, dataSaverMode, setDataSaverMode, systemSaveData, type DataSaverMode } from "@/lib/dataSaver";
import { cn } from "@/lib/utils";

const MODES: { m: DataSaverMode; label: string }[] = [
  { m: "auto", label: "Auto" },
  { m: "on", label: "On" },
  { m: "off", label: "Off" },
];

export function DataSaverRow() {
  const [mode, setMode] = useState<DataSaverMode>("auto");
  const [sys, setSys] = useState(false);
  useEffect(() => {
    setMode(dataSaverMode());
    setSys(systemSaveData());
    const on = () => setMode(dataSaverMode());
    window.addEventListener(DATA_SAVER_EVENT, on);
    return () => window.removeEventListener(DATA_SAVER_EVENT, on);
  }, []);
  return (
    <div className="flex items-center gap-3 border-t border-white/5 px-4 py-3 text-sm" data-testid="data-saver-row">
      <Gauge className="h-4 w-4 shrink-0 text-zinc-400" />
      <span className="min-w-0 flex-1">
        Data saver
        <span className="block truncate text-xs text-zinc-500">{mode === "auto" ? (sys ? "On now (your device asked to save data)" : "Follows your device") : mode === "on" ? "Lower video quality, tap to load" : "Best quality"}</span>
      </span>
      <div role="radiogroup" aria-label="Data saver" className="flex shrink-0 rounded-full bg-white/5 p-0.5">
        {MODES.map((x) => (
          <button
            key={x.m}
            role="radio"
            aria-checked={mode === x.m}
            onClick={() => {
              setDataSaverMode(x.m);
              setMode(x.m);
            }}
            className={cn("rounded-full px-2.5 py-1 text-xs font-medium", mode === x.m ? "bg-white/15 text-white" : "text-zinc-400")}
          >
            {x.label}
          </button>
        ))}
      </div>
    </div>
  );
}
