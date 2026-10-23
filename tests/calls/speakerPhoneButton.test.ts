import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const overlay = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
const button = readFileSync("src/components/calls/AudioRouteButton.tsx", "utf8");
const engine = readFileSync("src/lib/calls/engine.ts", "utf8");
test("call screen uses the route button (distinct icon + label per route) and announces route changes", () => {
  assert.ok(overlay.includes("<AudioRouteButton s={s} Btn={RoundBtn} />"));
  assert.ok(overlay.includes("<RouteNotice text={s.routeNotice} />"));
  for (const r of ['data-route="speaker"', 'data-route="phone"', 'data-route="headphones"', 'data-route="bluetooth"', 'data-route="car"', 'data-route="system"']) assert.ok(button.includes(r), r);
  assert.ok(button.includes('testId="call-speaker"') || button.includes("call-speaker"), "keeps the existing test id");
  assert.ok(button.includes("call-route-option-"), "picker options");
  assert.ok(button.includes('role="status"'), "route notice is announced to screen readers");
});
test("engine follows the actual native route, headsets included; device change re-enables auto routing", () => {
  assert.ok(engine.includes('addEventListener("openlounge:native-audio-route", (e) => this.onNativeRoute('));
  const i = engine.indexOf("private onNativeRoute("); assert.ok(i > 0);
  const body = engine.slice(i, i + 1400);
  assert.ok(!/d\.headset\)\s*return/.test(body), "headset events are not dropped");
  assert.ok(body.includes("this.routeUserPick = false"));
  assert.ok(body.includes("routeAnnouncement(prev, route)"));
});
test("manual pick: native gets route+deviceId, web uses setSinkId on every call audio element", () => {
  const i = engine.indexOf("async selectRoute("); assert.ok(i > 0);
  const body = engine.slice(i, i + 1500);
  assert.ok(body.includes('type: "call:audioRoute"') && body.includes("deviceId") && body.includes("user: true"));
  assert.ok(body.includes("applyWebSink(el)"));
  assert.ok(engine.includes('md.addEventListener("devicechange", on)'), "web reacts to device plug/unplug");
});
