// FX-044 — the 4:04 PM drop (call 89a7c572, Oct 23 2026): Wi-Fi ⇄ cellular switch → signalling socket closed (1005)
// → server closed the SFU session (session_closed) → every ms:transport:restartIce answered "Unknown media session",
// yet recovery kept ICE-restarting (logged as success) and rejoin later failed on ended tracks. Now: the first refusal
// marks the session gone, recovery goes straight to a full rebuild, and the rebuild uses freshly acquired tracks.
// Change to mediasoupSession.ts approved by Donny, Oct 23 2026 4:48 PM MST.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MediasoupCallSession } from "../../src/lib/calls/mediasoupSession";

type Ack = { ok: boolean; error?: string; iceParameters?: unknown };
function fakeSession(answer: () => Ack) {
  const calls: string[] = [];
  const socket = { request: async (ev: string) => (calls.push(ev), answer()), on() {}, off() {} };
  const s = new MediasoupCallSession(socket as never, { provider: "mediasoup", callId: "89a7c572" } as never, { onRemoteTrack() {}, onState() {}, onLocalVideo() {} });
  const restarted: string[] = [];
  const t = (id: string) => ({ id, restartIce: async () => void restarted.push(id) });
  Object.assign(s as unknown as Record<string, unknown>, { send: t("send-1"), recv: t("recv-1") });
  return { s, calls, restarted };
}

test("4:04 sequence: ICE restart works while the session lives, then 1005 → session_closed → Unknown media session marks it gone", async () => {
  let serverSession = true; // the SFU session for this socket
  const { s, restarted } = fakeSession(() => (serverSession ? { ok: true, iceParameters: { usernameFragment: "u", password: "p" } } : { ok: false, error: "Unknown media session" }));
  await s.restartIceAll();
  assert.equal(s.lastIceRestartOk, true);
  assert.equal(s.sessionGone, false);
  assert.deepEqual(restarted.sort(), ["recv-1", "send-1"]);
  // network switch: socket close code 1005 → server: session_closed
  serverSession = false;
  await s.restartIceAll();
  assert.equal(s.lastIceRestartOk, false, "a refused restart is logged as a failure, not ok=true");
  assert.equal(s.sessionGone, true);
  assert.equal(restarted.length, 2, "no transport.restartIce applied on a dead session");
});

test("other refusals (dead socket / unknown transport) do not mark the session gone", async () => {
  const { s } = fakeSession(() => ({ ok: false, error: "Unknown transport" }));
  await s.restartIceAll();
  assert.equal(s.sessionGone, false);
  assert.equal(s.lastIceRestartOk, false);
  const t = fakeSession(() => { throw new Error("socket closed"); });
  await t.s.restartIceAll();
  assert.equal(t.s.sessionGone, false);
  assert.equal(t.s.lastIceRestartOk, false);
});

test("recovery: sessionGone → skip remaining ICE restarts, rebuild at once; rebuild never reuses ended tracks", () => {
  const eng = readFileSync("src/lib/calls/engine.ts", "utf8");
  const rec = eng.slice(eng.indexOf("private async recoverMediasoup("), eng.indexOf("// ---------- reconnect ----------"));
  const gone = rec.indexOf("if (ice.sessionGone) break;");
  assert.ok(gone > rec.indexOf("restartIceAll()"), "checked right after the restart");
  assert.ok(gone < rec.indexOf("waitMsConnected(first, 2500)"), "no 2.5 s wait on a dead session");
  assert.ok(gone < rec.indexOf('this.netLog("ms-rebuild"'), "then the rebuild loop");
  assert.match(rec, /this\.netLog\("ms-ice-restart", \{ ok: ice\.lastIceRestartOk \?\? null, gone: !!ice\.sessionGone \}\)/);
  // rebuild = dropMediaForRejoin (stops + forgets old mic/camera) → connectMediasoup (acquires fresh ones)
  assert.ok(rec.indexOf("this.dropMediaForRejoin()") < rec.indexOf("this.connectMediasoup(media, true"));
  const drop = eng.slice(eng.indexOf("private dropMediaForRejoin()"), eng.indexOf("private async rejoin("));
  for (const k of ["this.micTrack = null", "this.camTrack = null", "this.preMic = null", "this.tapMic = null"]) assert.ok(drop.includes(k), k);
  const ms = readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
  assert.match(ms, /pre && pre\.readyState === "live"\s*\n?\s*\? pre\s*\n?\s*: \(await this\.local\(\(\) => navigator\.mediaDevices\.getUserMedia/, "an ended pre-track is never published (no 'track ended')");
});
