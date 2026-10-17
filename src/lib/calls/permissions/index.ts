// ensureCallReady(): one entry point, three fully separate platform modules (no shared permission path).
// It never prompts; it only detects a KNOWN denial early so the user gets the right platform-specific fix.
import { native, nativePlatform } from "../../native";
import { ensureCallReadyAndroid } from "./android";
import { ensureCallReadyIos } from "./ios";
import { ensureCallReadyWeb } from "./web";
import type { CallReadiness, ReadyInput } from "./types";

export type { CallReadiness } from "./types";

export function ensureCallReady(input: ReadyInput): Promise<CallReadiness> {
  const p = nativePlatform();
  if (p === "ios") return ensureCallReadyIos(input, native());
  if (p === "android") return ensureCallReadyAndroid(input, native());
  return ensureCallReadyWeb(input);
}

export type MediaPermissionSnapshot = { microphone: PermissionState | "unknown"; camera: PermissionState | "unknown"; at: number };

/**
 * Launch-time SILENT camera/mic status (store rules: no prompt at launch; the OS prompt only appears when a call starts).
 * permissions.query never prompts. Result is kept on window.__olMediaPerms for the call UI / diagnostics.
 */
export async function checkMediaPermissionsSilently(): Promise<MediaPermissionSnapshot> {
  const q = async (name: string): Promise<PermissionState | "unknown"> => {
    try {
      const p = typeof navigator !== "undefined" ? (navigator as Navigator & { permissions?: Permissions }).permissions : undefined;
      if (!p?.query) return "unknown";
      return (await p.query({ name } as unknown as PermissionDescriptor)).state;
    } catch {
      return "unknown";
    }
  };
  const snap: MediaPermissionSnapshot = { microphone: await q("microphone"), camera: await q("camera"), at: Date.now() };
  try {
    (window as unknown as { __olMediaPerms?: MediaPermissionSnapshot }).__olMediaPerms = snap;
  } catch {
    /* ignore */
  }
  return snap;
}
