// Critical media first. On a slow link every byte competes: the on-screen thumbnails, posters and their signed-URL
// request must not queue behind nice-to-have downloads (quick-reaction animations, the video player chunk).
// Critical loads register here; deferred work runs one task at a time (by priority) once nothing critical has been in
// flight for a moment. A hard cap keeps deferred work from starving forever on pages that never settle.
import { linkSlow } from "@/lib/dataSaver";

let inflight = 0;
let idleSince = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
const tasks: { prio: number; at: number; fn: () => unknown }[] = [];

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** A critical load started (thumbnail / poster / signing request). Call the returned function once when it settles. */
export function beginCritical(): () => void {
  inflight++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inflight = Math.max(0, inflight - 1);
    if (!inflight) idleSince = now();
    schedule();
  };
}

/**
 * Run `fn` after the critical loads settle (lower `prio` first). A promise returned by `fn` holds the queue until it
 * settles (max 20 s), so deferred downloads don't fight each other either.
 */
export function afterCritical(fn: () => unknown, prio = 5) {
  if (typeof window === "undefined") return;
  tasks.push({ prio, at: now(), fn });
  tasks.sort((a, b) => a.prio - b.prio || a.at - b.at);
  schedule();
}

function schedule(delay = 250) {
  if (timer || running || !tasks.length) return;
  timer = setTimeout(tick, delay);
}

function tick() {
  timer = null;
  const t = tasks[0];
  if (!t) return;
  const slow = linkSlow();
  const waited = now() - t.at;
  // settle time: the thread's first media requests start a beat after the chat mounts, so give them a head start
  const minWait = slow ? 3000 : 1200;
  const quiet = !inflight && now() - idleSince >= (slow ? 800 : 300);
  const cap = slow ? 45_000 : 10_000;
  if (!((quiet && waited >= minWait) || waited >= cap)) return schedule(inflight ? 400 : 250);
  tasks.shift();
  running = true;
  let r: unknown;
  try {
    r = t.fn();
  } catch {}
  const next = () => {
    running = false;
    schedule(50);
  };
  if (r && typeof (r as Promise<unknown>).then === "function") {
    const cut = setTimeout(next, 20_000);
    (r as Promise<unknown>).then(
      () => (clearTimeout(cut), next()),
      () => (clearTimeout(cut), next()),
    );
  } else next();
}

/** test/debug: what's pending */
export const criticalState = () => ({ inflight, queued: tasks.length, running });
