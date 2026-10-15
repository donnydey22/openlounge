// Calling isolation contract (REGRESSION_PATTERN_REPORT §5): ring audio and call SW handlers are separate from
// room/join sounds and join/every-member notification handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p: string) => readFileSync(p, "utf8");

test("ring owns its own element: audioUnlock no longer exports ringAudioElement", () => {
  assert.doesNotMatch(src("src/lib/audioUnlock.ts"), /export function ringAudioElement/);
  assert.match(src("src/lib/calls/ringAudio.ts"), /export function ringAudioElement/);
  assert.match(src("src/lib/calls/tones.ts"), /from "@\/lib\/calls\/ringAudio"/);
  assert.match(src("src/lib/calls/backgroundRing.ts"), /from "@\/lib\/calls\/ringAudio"/);
});

test("room / join UI never imports call ring audio", () => {
  for (const f of ["src/hooks/useLiveKitAudio.ts", "src/components/Notifier.tsx"]) assert.doesNotMatch(src(f), /calls\/ringAudio/, f);
});

type Note = { title: string; opts: { tag?: string; data?: Record<string, unknown> }; closed: boolean; close(): void };
function loadSw() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const notes: Note[] = [];
  const posted: unknown[] = [];
  const opened: string[] = [];
  const client = { id: "c1", url: "https://x.test/", focused: true, visibilityState: "visible", focus: async () => {}, postMessage: (m: unknown) => posted.push(m) };
  const self = {
    location: { origin: "https://x.test" },
    addEventListener: (n: string, f: (e: unknown) => void) => (handlers[n] = f),
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [client], openWindow: async (u: string) => opened.push(u) },
    registration: {
      showNotification: async (title: string, opts: Note["opts"]) => {
        const n: Note = { title, opts, closed: false, close() { this.closed = true; } };
        notes.push(n);
      },
      getNotifications: async ({ tag }: { tag: string }) => notes.filter((n) => n.opts.tag === tag && !n.closed),
    },
  };
  vm.runInNewContext(src("public/sw.js"), { self, setInterval, clearInterval, URL, Date, console });
  return { handlers, notes, posted, opened };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const click = async (h: Record<string, (e: unknown) => void>, data: Record<string, unknown>, action = "") => {
  const waits: Promise<unknown>[] = [];
  h.notificationclick({ action, notification: { data, close() {} }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  await tick();
};

test("SW: join / every-member notification click navigates exactly as before (general section)", async () => {
  const { handlers, posted } = loadSw();
  await click(handlers, { url: "/room/r1", kind: "room_join" });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: "openlounge:navigate", url: "https://x.test/room/r1" }]);
});

test("SW: call ring stop closes only the call notification, never a join notification", async () => {
  const { handlers, notes } = loadSw();
  notes.push({ title: "join", opts: { tag: "room:r1", data: { kind: "room_join" } }, closed: false, close() { this.closed = true; } });
  handlers.message({ data: { type: "openlounge:call-ring-start", callId: "k1", expiresAt: Date.now() + 60_000 } });
  await tick();
  handlers.message({ data: { type: "openlounge:call-ring-stop", callId: "k1" } });
  await tick();
  const call = notes.filter((n) => n.opts.tag === "call:k1");
  assert.ok(call.length >= 1 && call.every((n) => n.closed));
  assert.equal(notes.find((n) => n.opts.tag === "room:r1")!.closed, false);
});

test("SW: accept / decline on the call notification post the call messages", async () => {
  const a = loadSw();
  await click(a.handlers, { kind: "call_ring", callId: "k2", url: "/call/k2", acceptUrl: "/call/k2?accept=1" }, "accept");
  assert.deepEqual(JSON.parse(JSON.stringify(a.posted)), [
    { type: "openlounge:navigate", url: "https://x.test/call/k2?accept=1" },
    { type: "openlounge:call-accept", callId: "k2" },
  ]);
  const d = loadSw();
  await click(d.handlers, { kind: "call_ring", callId: "k3" }, "decline");
  assert.deepEqual(JSON.parse(JSON.stringify(d.posted)), [{ type: "openlounge:call-decline", callId: "k3" }]);
});
