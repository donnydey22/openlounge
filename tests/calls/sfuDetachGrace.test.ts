// FX-078 must-pass (call bbbe198f, Oct 24 8:10 PM MST): Keiko's socket dropped (Wi-Fi -> cellular), the SFU closed her
// session at once ("browser_socket_closed") and every reconnect got "Unknown media session". The SFU now keeps the
// session for a grace period and a request from the same user + call on a new connection re-attaches it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../media-sfu/src/index.mjs", import.meta.url), "utf8");
const body = src.slice(src.indexOf("function participantKey"), src.indexOf("function publicTransport"));
type S = { callId: string; userId: string; connectionId: string; participantKey: string; closed: boolean; detachedAt?: number; transports: Map<string, { close(): void }>; producers: Map<string, { close(): void }>; consumers: Map<string, { close(): void }> };
const load = () => {
  const logs: string[] = []; const timers: Array<() => void> = [];
  const sessions = new Map<string, S>(); const byP = new Map<string, string>();
  const fakeSetTimeout = (fn: () => void) => { timers.push(fn); return { unref() {} }; };
  const api = new Function("sessions", "sessionsByParticipant", "safeLog", "b64", "setTimeout", "clearTimeout",
    `${body}; return { sessionOf, closeConnection, closeSession, closeCall, participantKey };`)(
    sessions, byP, (ev: string) => logs.push(ev), (x: string) => x, fakeSetTimeout, () => {});
  const add = (conn: string, user: string) => {
    const s: S = { callId: "c1", userId: user, connectionId: conn, participantKey: `c1:${user}`, closed: false, transports: new Map([["t", { close() {} }]]), producers: new Map(), consumers: new Map() };
    sessions.set(conn, s); byP.set(s.participantKey, conn); return s;
  };
  return { api, add, sessions, logs, expire: () => timers.splice(0).forEach((f) => f()) };
};

test("bbbe198f replay: socket drop keeps the session; the reconnected socket re-attaches it", () => {
  const { api, add, sessions, logs } = load();
  const keiko = add("sockA", "keiko");
  api.closeConnection("sockA");                        // 8:11:03 PM socket 1006
  assert.equal(keiko.closed, false);
  assert.ok(logs.includes("session_detached"));
  const s = api.sessionOf({ callId: "c1", userId: "keiko", connectionId: "sockB" }); // 8:11:05 restartIce on the new socket
  assert.equal(s, keiko);
  assert.equal(keiko.connectionId, "sockB");
  assert.ok(sessions.has("sockB") && !sessions.has("sockA"));
  assert.ok(logs.includes("session_reattached"));
});

test("grace expiry still closes (as before), and only the same user + call can re-attach", () => {
  const { api, add, expire, logs } = load();
  const k = add("sockA", "keiko");
  api.closeConnection("sockA");
  assert.throws(() => api.sessionOf({ callId: "c1", userId: "mallory", connectionId: "sockX" }), /Unknown media session/);
  assert.throws(() => api.sessionOf({ callId: "c2", userId: "keiko", connectionId: "sockX" }), /Unknown media session/);
  expire();
  assert.equal(k.closed, true);
  assert.ok(logs.includes("session_closed"));
  assert.throws(() => api.sessionOf({ callId: "c1", userId: "keiko", connectionId: "sockB" }), /Unknown media session/);
});

test("a live (non-detached) session is never taken over by another connection", () => {
  const { api, add } = load();
  add("sockA", "keiko");
  assert.throws(() => api.sessionOf({ callId: "c1", userId: "keiko", connectionId: "sockB" }), /Unknown media session/);
});

test("server passes 'Unknown media session' through so the client rebuilds at once", () => {
  const s = readFileSync(new URL("../../server/calls/index.ts", import.meta.url), "utf8");
  assert.match(s, /\/unknown media session\/i\.test\(msg\) \? "Unknown media session" : "UDP media unavailable"/);
});
