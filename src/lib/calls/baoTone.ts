import type { CallSnapshot } from "./engine";

/**
 * BaoTime state colour (Donny, Nov 18 2026 Step 2; Telegram's state-colour logic): initiating blue-violet while
 * ringing / connecting / reconnecting, connected blue-green once media runs, red on Failed, slate on a clean end.
 * Additive: a tint layer under the existing shade; layout, controls and native video layout are unchanged.
 */
export function baoTone(s: Pick<CallSnapshot, "ui" | "reconnecting" | "canRetry">): "initiating" | "connected" | "failed" | "ended" {
  if (s.ui === "ended") return s.canRetry ? "failed" : "ended";
  if (s.ui === "active" && !s.reconnecting) return "connected";
  return "initiating";
}
