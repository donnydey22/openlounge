import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TURN_CREDENTIAL_TTL_S, TURN_URLS, mintTurnIceServers, turnCredentialTtl } from "../../server/turnCredentials";
import { CallService } from "../../server/calls/service";
import { LIVEKIT_RTC_CONFIG, livekitRtcConfig } from "../../src/lib/livekitIce";

test("coturn REST credentials are short-lived, opaque, and HMAC-SHA1/base64 signed", () => {
  const secret = "turn-unit-test-secret-not-production";
  const callId = "call-internal-identifier";
  const userId = "user-internal-identifier";
  const now = 1_800_000_000_000;
  const servers = mintTurnIceServers(callId, userId, { secret, now: () => now });

  assert.ok(servers);
  assert.equal(servers.length, 1);
  const [server] = servers;
  assert.deepEqual(server.urls, TURN_URLS);
  assert.equal(server.credentialType, "password");

  const [expiry, opaqueId] = server.username.split(":");
  assert.equal(Number(expiry), Math.floor(now / 1000) + TURN_CREDENTIAL_TTL_S);
  assert.match(opaqueId, /^call-[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(server.username, new RegExp(`${callId}|${userId}`));
  assert.equal(server.credential, createHmac("sha1", secret).update(server.username).digest("base64"));
  assert.equal(JSON.stringify(servers).includes(secret), false, "static secret reached the client payload");
});

test("missing TURN secret preserves the explicit empty-ICE LiveKit/TCP path", () => {
  assert.equal(mintTurnIceServers("call", "user", { secret: "" }), null);
  assert.deepEqual(livekitRtcConfig(), LIVEKIT_RTC_CONFIG);
  assert.deepEqual(livekitRtcConfig(null), { iceTransportPolicy: "all", iceServers: [] });
});

test("CallService hands TURN configuration only to authenticated live-call participants and falls back when disabled", async () => {
  const makeService = (secret: string) =>
    new CallService({
      emitUser() {},
      isConnected: () => true,
      isForeground: () => true,
      peer: (id) => ({ id, name: id, color: "#000000", photoUrl: null }),
      policy: () => ({ ok: true }),
      inRoom: () => false,
      appendCallMessage() {},
      mintToken: async (callId, userId) => `test-livekit-token:${callId}:${userId}`,
      mediaUrl: () => "wss://livekit.example.test",
      turnIceServers: (callId, userId) => mintTurnIceServers(callId, userId, { secret, now: () => 1_800_000_000_000 }),
      closeMedia() {},
    });

  const withTurn = makeService("turn-call-service-test-secret-not-production");
  try {
    const start = await withTurn.start("caller", "callee", false);
    if (!start.ok) throw new Error(start.error);
    assert.deepEqual(start.media?.iceServers?.[0]?.urls, TURN_URLS);
    assert.equal((await withTurn.get_(start.call.id, "stranger")).ok, false, "non-participant received call media");
  } finally {
    withTurn.dispose();
  }

  const tcpOnly = makeService("");
  try {
    const start = await tcpOnly.start("caller", "callee", false);
    if (!start.ok) throw new Error(start.error);
    assert.equal(start.media?.iceServers, undefined, "disabled TURN changed the explicit-empty-ICE path");
  } finally {
    tcpOnly.dispose();
  }
});

test("TURN credential lifetime: 6 h default, TURN_CREDENTIAL_TTL_S override clamped to 10 min .. 24 h", () => {
  assert.equal(TURN_CREDENTIAL_TTL_S, 6 * 3600);
  assert.equal(turnCredentialTtl(undefined), 6 * 3600);
  assert.equal(turnCredentialTtl("garbage"), 6 * 3600);
  assert.equal(turnCredentialTtl("7200"), 7200);
  assert.equal(turnCredentialTtl("60"), 600);
  assert.equal(turnCredentialTtl("999999"), 86400);
  const now = 1_800_000_000_000;
  const [s] = mintTurnIceServers("c", "u", { secret: "x", now: () => now, ttlS: 1234 })!;
  assert.equal(Number(s.username.split(":")[0]), now / 1000 + 1234);
});
