"use client";
// Premium → native shells (custom app icons). Uses the existing optional bridge window.OpenLoungeNative
// (src/lib/native.ts). Shells implement setAppIcon(name) or accept the JSON message via postMessage; older shells
// have neither and ignore it. Spec: docs/native-app-icons.md
import { native } from "../native";

export function postToNative(msg: { type: "setAppIcon"; name: string | null }) {
  const n = native() as (ReturnType<typeof native> & { setAppIcon?(name: string): void }) | null;
  if (!n) return false;
  try {
    if (msg.type === "setAppIcon" && typeof n.setAppIcon === "function") return n.setAppIcon(msg.name ?? ""), true;
    if (typeof n.postMessage === "function") return n.postMessage(JSON.stringify(msg)), true;
  } catch {}
  return false;
}
