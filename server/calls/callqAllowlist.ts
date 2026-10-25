// FX-082 server-side per-user rollout allowlist for call-quality experiments (Donny, Oct 24 2026 9:19 PM MST:
// "deploy simulcast for test accounts"). Only these EXISTING test accounts get the extra `callq` grant on their call
// media; every other user's CallMedia is byte-identical to before (no `callq` key at all).
// Override with CALLQ_TEST_USER_IDS (comma-separated) on the server; "off" disables the grant for everyone.
const DEFAULT_TEST_USER_IDS = [
  "u_cc9df5f2-ca15-422e-ba6f-3f1d2909d577", // testverifier2
  "u_71be5050-35bc-4a38-8436-0ec8ff9b5858", // Jordan Ellis (test)
  "u_d437878e-c4c4-4cd7-a814-6651aa4a88b5", // Sam Rivera (test)
];

export function callqTestUsers(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  const raw = env.CALLQ_TEST_USER_IDS?.trim();
  if (raw === "off") return new Set();
  if (raw) return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return new Set(DEFAULT_TEST_USER_IDS);
}

export type CallqGrant = { simulcast: true };

/** The grant for this user, or null (= no `callq` key, the previous behaviour). */
export function callqGrantFor(userId: string, users: ReadonlySet<string> = callqTestUsers()): CallqGrant | null {
  return users.has(userId) ? { simulcast: true } : null;
}
