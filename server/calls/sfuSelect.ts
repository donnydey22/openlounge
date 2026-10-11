/**
 * UDP-first selection. CALL_SFU=layered turns it on for everyone. CALL_SFU_TEST_USERS (comma-separated user ids,
 * server-side only) opts in a call only when BOTH participants are listed, so test accounts can exercise the SFU in
 * production while every other call stays on LiveKit.
 */
export function sfuSelected(participants?: { callerId: string; calleeId: string }, env: Record<string, string | undefined> = process.env): boolean {
  if (env.CALL_SFU === "layered") return true;
  if (!participants) return false;
  const allow = new Set((env.CALL_SFU_TEST_USERS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  return allow.has(participants.callerId) && allow.has(participants.calleeId);
}

