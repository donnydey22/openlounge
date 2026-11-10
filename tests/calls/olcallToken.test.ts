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
  OLCALL_URL: "wss://turn.openlounge.app/v1/call", OLCALL_TOKEN_SECRET: vectorSecret, ...o,
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

test("participants only, every platform; no switch", () => {
  assert.equal(olcallEligible(call, "a"), true);
  assert.equal(olcallEligible(call, "b"), true);
  assert.equal(olcallEligible({ ...call, calleePlatform: "ios" }, "a"), true);
  assert.equal(olcallEligible(call, "c"), false);
  assert.equal(olcallEligible(null, "a"), false);
});

test("olcall media with per-role token; no TURN creds or p2p fields carried over", () => {
  const now = 1_800_000_000_000;
  const a = olcallMediaFor(call, "a", env(), now)!;
  const b = olcallMediaFor(call, "b", env(), now)!;
  assert.equal(a.provider, "olcall");
  assert.equal(a.url, "wss://turn.openlounge.app/v1/call");
  assert.equal(a.iceServers, undefined);
  assert.equal(a.expiresAt, now / 1000 + OLCALL_TOKEN_TTL_S);
  const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());
  assert.deepEqual(claims(a.token), { callId: "call-1", userId: "a", role: "caller", exp: now / 1000 + OLCALL_TOKEN_TTL_S });
  assert.equal(claims(b.token).role, "callee");
  const [p1, sig] = a.token.split(".");
  assert.equal(sig, createHmac("sha256", vectorSecret).update(p1).digest("base64url"));
});

test("no fallback: missing secret / bad url / non-participant -> null media, never p2p", () => {
  assert.equal(olcallMediaFor(call, "a", env({ OLCALL_TOKEN_SECRET: "" })), null);
  assert.equal(olcallMediaFor(call, "a", env({ OLCALL_URL: "rtc" })), null);
  assert.equal(olcallMediaFor(call, "c", env()), null);
});

test("withOlcallMedia replaces p2p media in every {media} payload and never throws", () => {
  const ack = { ok: true, call, media: p2p };
  const out = withOlcallMedia("a", ack, env()) as typeof ack;
  assert.equal(out.media.provider, "olcall");
  assert.equal(ack.media.provider, "p2p"); // input not mutated
  assert.equal((withOlcallMedia("a", ack, env({ OLCALL_TOKEN_SECRET: "" })) as typeof ack).media, null);
  assert.equal((withOlcallMedia("a", { ok: true, media: p2p }, env()) as { media: unknown }).media, null);
  const other = { ok: false, error: "x" };
  assert.equal(withOlcallMedia("a", other, env()), other);
  assert.equal(withOlcallMedia("a", null, env()), null);
  assert.ok(!JSON.stringify(out).includes(vectorSecret));
});

test("coturn iceServers: same list Pion serves (STUN + TURN/TURNS 3478/5349), temporary shared-secret creds", () => {
  const turnSecret = "t".repeat(64);
  const m = olcallMediaFor(call, "a", env({ OLCALL_TURN_SECRET: turnSecret }))!;
  const ice = m.iceServers as Array<{ urls: string[]; username?: string; credential?: string }>;
  assert.deepEqual(ice.flatMap((s) => s.urls), ["stun:turn.openlounge.app:3478", "turn:turn.openlounge.app:3478?transport=udp", "turn:turn.openlounge.app:3478?transport=tcp", "turns:turn.openlounge.app:5349?transport=tcp"]);
  const t = ice[1];
  assert.match(t.username!, /^\d+:call-/);
  assert.equal(t.credential, createHmac("sha1", turnSecret).update(t.username!).digest("base64"));
  assert.ok(!JSON.stringify(m).includes(turnSecret));
  assert.ok(!JSON.stringify(m).includes("13478") && !JSON.stringify(m).includes("18443"));
});
