// t4495u iPhone<->Android handshake checklist: must-pass server-side checks (node --test, no network, no secrets).
// Phone-side items are checked in openlounge-ios / openlounge-android; open gaps are test.todo so they stay visible.
import test from "node:test";
import assert from "node:assert/strict";
import { iceConfig } from "../../call-signal/src/core.mjs";
import { plainTransportOptions, VIDEO_CODECS, PLAIN_SRTP_SUITE, PEER_TRANSPORTS } from "../../media-sfu/src/plain.mjs";

const ice = (mode) => iceConfig({ secret: "x", userId: "u", now: 0, mode });

test("#3 ICE: TURN udp/tcp 3478 + TURNS tcp 443 fallback; p2p relay-only, SFU mode all", () => {
  const urls = ice("p2p").iceServers.flatMap((s) => s.urls);
  assert.ok(urls.includes("turns:turn.openlounge.app:443?transport=tcp"));
  assert.ok(urls.includes("turn:turn.openlounge.app:3478?transport=tcp"));
  assert.equal(ice("p2p").policy.iceTransportPolicy, "relay");
  assert.equal(ice("sfu").policy.iceTransportPolicy, "all");
  for (const s of ice("p2p").iceServers.filter((s) => s.urls[0].startsWith("turn"))) assert.ok(s.username && s.credential, "TURN creds present");
});
test("#4 SRTP: one keying mode everywhere = SDES AES_CM_128_HMAC_SHA1_80", () => {
  assert.equal(PLAIN_SRTP_SUITE, "AES_CM_128_HMAC_SHA1_80");
  const o = plainTransportOptions(); assert.equal(o.enableSrtp, true); assert.equal(o.srtpCryptoSuite, "AES_CM_128_HMAC_SHA1_80");
});
test("#5 H.264 pinned 42e01f / packetization-mode=1", () => {
  assert.equal(VIDEO_CODECS.h264.parameters["profile-level-id"], "42e01f");
  assert.equal(VIDEO_CODECS.h264.parameters["packetization-mode"], 1);
});
test("#6 rtcp-mux on, separate audio/video PlainTransports (no BUNDLE)", () => {
  assert.equal(plainTransportOptions().rtcpMux, true);
  assert.ok(PEER_TRANSPORTS.includes("audio") && PEER_TRANSPORTS.includes("video"));
});
test.todo("#1 native phone p2p offer/answer over call-signal carrying TURN creds (phones use sfu:plain only today)");
test.todo("#2 call-signal push() wired to FCM high-priority / APNs VoIP (index.mjs logs TODO)");
test.todo("#8 SFU/TURN reachable over IPv6 (no AAAA; announced address IPv4) - needs Donny's go");
test.todo("#10 network change -> new PlainTransport / ICE restart on phones");
