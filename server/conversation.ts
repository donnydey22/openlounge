/** Group conversations have ids "g_<random>"; user ids are "u_<uuid>" / "bot-…", so the namespaces never collide. */
export const isGroupId = (id: unknown): boolean => typeof id === "string" && id.startsWith("g_");
/**
 * Stable id for a conversation (order-independent). 1:1 → "<smaller id>|<larger id>". When either side is a group id
 * the conversation IS the group, so every DM code path keyed by conversationId(me, peerOrGroup) works for groups too.
 */
export const conversationId = (a: string, b: string) => (isGroupId(b) ? b : isGroupId(a) ? a : a < b ? `${a}|${b}` : `${b}|${a}`);
