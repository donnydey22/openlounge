"use client";
import { useSyncExternalStore } from "react";
import { callEngine, type CallSnapshot } from "@/lib/calls/engine";

const EMPTY = { v: -1 } as CallSnapshot;
export function useCall(): CallSnapshot {
  return useSyncExternalStore(
    (l) => (callEngine ? callEngine.subscribe(l) : () => {}),
    () => (callEngine ? callEngine.snapshot() : EMPTY),
    () => EMPTY,
  );
}
