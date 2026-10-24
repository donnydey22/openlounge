// Durable text outbox: messages typed with no signal survive an app restart and are sent when the socket is back.
// Per signed-in user (key includes the user id; all wiped on sign-out / account switch). The server dedupes by
// clientId, so a thread screen and the background flusher racing on the same item can never store it twice.
export type PendingSend = { clientId: string; to: string; text: string; replyToId?: string; replyTo?: unknown; createdAt: number; fromId: string; fromName?: string; fromColor?: string; failed?: boolean };

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const PREFIX = "ol-pending:";
const ls = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
const listeners = new Set<() => void>();

export function readPending(meId: string, kv: KV | null = ls()): PendingSend[] {
  try {
    const raw = kv?.getItem(PREFIX + meId);
    const list = raw ? (JSON.parse(raw) as PendingSend[]) : [];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.clientId === "string" && typeof p.to === "string" && typeof p.text === "string" && p.fromId === meId) : [];
  } catch {
    return [];
  }
}

function write(meId: string, list: PendingSend[], kv: KV | null) {
  try {
    if (list.length) kv?.setItem(PREFIX + meId, JSON.stringify(list));
    else kv?.removeItem(PREFIX + meId);
  } catch {
    /* quota: the in-memory queue still sends while the app stays open */
  }
  for (const l of listeners) l();
}

export function addPending(meId: string, p: PendingSend, kv: KV | null = ls()) {
  const list = readPending(meId, kv);
  if (list.some((x) => x.clientId === p.clientId)) return;
  write(meId, [...list, p], kv);
}

export function removePending(meId: string, clientId: string, kv: KV | null = ls()) {
  const list = readPending(meId, kv);
  if (!list.some((x) => x.clientId === clientId)) return;
  write(meId, list.filter((x) => x.clientId !== clientId), kv);
}

export const pendingFor = (meId: string, to: string, kv: KV | null = ls()) => readPending(meId, kv).filter((p) => p.to === to);

/** Every account's queue (sign-out / account switch). */
export function clearAllPending(kv: KV | null = ls()) {
  try {
    if (!kv) return;
    const keys: string[] = [];
    for (let i = 0; i < kv.length; i++) {
      const k = kv.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) kv.removeItem(k);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function onPendingChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Send everything queued for `meId`, oldest first. A dropped connection stops the run (order kept, retried on the
 *  next reconnect); a real rejection marks that item failed (the thread shows tap-to-retry) and the rest continue. */
export async function flushPending(meId: string, send: (p: PendingSend) => Promise<unknown>, transient: (e: unknown) => boolean, kv: KV | null = ls()) {
  let sent = 0;
  for (const p of readPending(meId, kv).filter((x) => !x.failed).sort((a, b) => a.createdAt - b.createdAt)) {
    try {
      await send(p);
      removePending(meId, p.clientId, kv);
      sent++;
    } catch (e) {
      if (transient(e)) break;
      write(meId, readPending(meId, kv).map((x) => (x.clientId === p.clientId ? { ...x, failed: true } : x)), kv);
    }
  }
  return sent;
}

/** tap-to-retry: back into the queue */
export function unfailPending(meId: string, clientId: string, kv: KV | null = ls()) {
  const list = readPending(meId, kv);
  if (list.some((x) => x.clientId === clientId && x.failed)) write(meId, list.map((x) => (x.clientId === clientId ? { ...x, failed: undefined } : x)), kv);
}

/** a real rejection from the thread screen: kept (survives restart as "Not delivered · Retry"), not auto-resent */
export function failPending(meId: string, clientId: string, kv: KV | null = ls()) {
  const list = readPending(meId, kv);
  if (list.some((x) => x.clientId === clientId && !x.failed)) write(meId, list.map((x) => (x.clientId === clientId ? { ...x, failed: true } : x)), kv);
}
