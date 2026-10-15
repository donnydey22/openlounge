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
