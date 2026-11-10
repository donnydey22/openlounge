// olcall join tokens (server/calls/olcallToken.ts): byte-identical to the Go signer, gated, p2p fallback untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signOlcallToken, olcallEligible, olcallMediaFor, withOlcallMedia, olcallSecret, OLCALL_TOKEN_TTL_S } from "../../server/calls/olcallToken";
import type { CallMedia } from "../../src/lib/types";

// Pinned to the Go vector: `go run ./cmd/olcall-token -vector` (olcall/integration/token_vector_test.go).
const vectorSecret = "olcall-public-test-vector-secret-0123456789";
const vectorToken =
  "eyJjYWxsSWQiOiJjYWxsLXZlY3Rvci0xIiwidXNlcklkIjoidXNlci00MiIsInJvbGUiOiJjYWxsZXIiLCJleHAiOjE4OTM0NTYwMDB9.DCDbfj0041vyFg_RS_ctxN-pBuoWLjykejGDEd38P7w";

const env = (o: Record<string, string> = {}) => ({
  OLCALL_ENABLED: "1", OLCALL_URL: "wss://turn.openlounge.app/v1/call", OLCALL_TOKEN_SECRET: vectorSecret, OLCALL_TEST_USERS: "a, b", ...o,
});
const call = { id: "call-1", callerId: "a", calleeId: "b", callerPlatform: "android", calleePlatform: "android" };
const p2p: CallMedia = { provider: "p2p", url: "rtc", token: "", callId: "call-1", expiresAt: 1, iceServers: [{ urls: ["turn:x"], username: "u", credential: "c", credentialType: "password" }] };

test("matches the Go server signer byte-for-byte", () => {
  assert.equal(signOlcallToken(vectorSecret, { callId: "call-vector-1", userId: "user-42", role: "caller", exp: 1893456000 }), vectorToken);
});

test("rejects bad input", () => {
  assert.throws(() => signOlcallToken("short", { callId: "c", userId: "u", role: "caller", exp: 1 }));
  assert.throws(() => signOlcallToken(vectorSecret, { callId: "", userId: "u", role: "caller", exp: 1 }));
  assert.throws(() => signOlcallToken(vectorSecret, { callId: "c", userId: "u", role: "host" as never, exp: 1 }));
});

test("secret: env var or file, trimmed, >= 32 bytes, else null", () => {
  assert.equal(olcallSecret({ OLCALL_TOKEN_SECRET: ` ${vectorSecret}\n` })?.toString(), vectorSecret);
  assert.equal(olcallSecret({ OLCALL_TOKEN_SECRET: "short" }), null);
  assert.equal(olcallSecret({ OLCALL_TOKEN_SECRET_FILE: "/nonexistent/olcall" }), null);
  assert.equal(olcallSecret({}), null);
});

test("gate: off by default, both users allowlisted, both android, ws(s) url, participant only", () => {
  assert.equal(olcallEligible(call, "a", env()), true);
  assert.equal(olcallEligible(call, "b", env()), true);
  assert.equal(olcallEligible(call, "a", env({ OLCALL_ENABLED: "" })), false);
  assert.equal(olcallEligible(call, "a", {}), false);
  assert.equal(olcallEligible(call, "c", env()), false);
  assert.equal(olcallEligible(call, "a", env({ OLCALL_TEST_USERS: "a" })), false);
  assert.equal(olcallEligible(call, "a", env({ OLCALL_TEST_USERS: "*" })), true);
  assert.equal(olcallEligible({ ...call, calleePlatform: "ios" }, "a", env({ OLCALL_TEST_USERS: "*" })), false);
  assert.equal(olcallEligible(call, "a", env({ OLCALL_TEST_USERS: "" })), false);
  assert.equal(olcallEligible({ ...call, calleePlatform: "ios" }, "a", env()), false);
  assert.equal(olcallEligible({ ...call, callerPlatform: undefined }, "a", env()), false);
  assert.equal(olcallEligible(call, "a", env({ OLCALL_URL: "https://x" })), false);
});

test("eligible: olcall media with per-role token; TURN list kept as fallback", () => {
  const now = 1_800_000_000_000;
  const a = olcallMediaFor(call, "a", p2p, env(), now)!;
  const b = olcallMediaFor(call, "b", p2p, env(), now)!;
  assert.equal(a.provider, "olcall");
  assert.equal(a.url, "wss://turn.openlounge.app/v1/call");
  assert.deepEqual(a.iceServers, p2p.iceServers);
  assert.equal(a.expiresAt, now / 1000 + OLCALL_TOKEN_TTL_S);
  const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());
  assert.deepEqual(claims(a.token), { callId: "call-1", userId: "a", role: "caller", exp: now / 1000 + OLCALL_TOKEN_TTL_S });
  assert.equal(claims(b.token).role, "callee");
  const [p1, sig] = a.token.split(".");
  assert.equal(sig, createHmac("sha256", vectorSecret).update(p1).digest("base64url"));
});

test("not eligible or no secret: the exact p2p media object is returned (old clients unchanged)", () => {
  assert.equal(olcallMediaFor(call, "a", p2p, env({ OLCALL_ENABLED: "0" })), p2p);
  assert.equal(olcallMediaFor(call, "a", p2p, env({ OLCALL_TOKEN_SECRET: "" })), p2p);
  assert.equal(olcallMediaFor({ ...call, calleePlatform: "web" }, "a", p2p, env()), p2p);
  assert.equal(olcallMediaFor(call, "a", null, env()), null);
});

test("withOlcallMedia rewrites only {call, media:p2p} payloads and never throws", () => {
  const ack = { ok: true, call, media: p2p };
  assert.equal(withOlcallMedia("a", ack, env({ OLCALL_ENABLED: "" })), ack);
  const out = withOlcallMedia("a", ack, env()) as typeof ack;
  assert.equal(out.media.provider, "olcall");
  assert.equal(ack.media.provider, "p2p"); // input not mutated
  const other = { ok: false, error: "x" };
  assert.equal(withOlcallMedia("a", other, env()), other);
  assert.equal(withOlcallMedia("a", null, env()), null);
  assert.ok(!JSON.stringify(out).includes(vectorSecret));
});
