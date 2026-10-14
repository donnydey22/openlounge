"use client";
// One-time, dismissible note on first visit for browsers at or above the support floor. Uses the app's existing
// banner (toast notice) styling. Never inside the Open Lounge wrapper apps.
import { useEffect } from "react";
import { useApp } from "@/components/AppProvider";
import { shouldShowSupportedNote, SUPPORTED_NOTE_KEY } from "@/lib/browserFloor";

export function BrowserSupportedNote() {
  const { banner } = useApp();
  useEffect(() => {
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      return;
    }
    if (!shouldShowSupportedNote(navigator.userAgent, store)) return;
    try {
      store.setItem(SUPPORTED_NOTE_KEY, String(Date.now()));
    } catch {
      return; // no persistent flag → don't risk showing it on every visit
    }
    banner({ title: "Your browser is supported.", key: SUPPORTED_NOTE_KEY, avatar: "app" });
  }, [banner]);
  return null;
}
