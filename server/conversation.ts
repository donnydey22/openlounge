/** Stable id for a 1:1 conversation (order-independent). */
export const conversationId = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
