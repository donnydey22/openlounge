// "On a call on another device": a silent, display-only indicator for the same account's OTHER devices.
// It never rings, never touches audio, and is driven purely by the server's call:state broadcasts to user:<id>.
import type { CallInfo } from "../types";

export interface ElsewhereCall {
  callId: string;
  peerName: string;
  video: boolean;
  since: number;
}

export function nextElsewhere(prev: ElsewhereCall | null, call: CallInfo, meId: string | null, localOnThisDevice: boolean, now = Date.now()): ElsewhereCall | null {
  if (!meId || (call.callerId !== meId && call.calleeId !== meId)) return prev;
  if (localOnThisDevice) return prev?.callId === call.id ? null : prev;
  if (call.phase === "active") {
    if (prev?.callId === call.id) return prev;
    const peer = call.callerId === meId ? call.callee : call.caller;
    return { callId: call.id, peerName: peer?.name?.split(" ")[0] ?? "someone", video: call.video, since: now };
  }
  if (call.phase === "ended" && prev?.callId === call.id) return null;
  return prev;
}
