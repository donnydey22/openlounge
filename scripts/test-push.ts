// Unit tests: notification triggers + gates, prefs, contacts hashing, Firebase phone login. Run: npm run test:push
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ol-push-"));
delete process.env.DATABASE_URL;
process.env.DEMO_SEED = "0";

async function main() {
const { Notifier, ACTIVE_ROOM_INTERVAL_MS, FOLLOWER_BATCH_MS, HOURLY_CAP } = await import("../server/push/notifier");
const { MemoryPushRepo } = await import("../server/push/repo");
const { MemorySender } = await import("../server/push/sender");
const { mergePrefs, inQuietHours, DEFAULT_PREFS } = await import("../server/push/prefs");
const { clientHash, pepperHash, setContactsPepper } = await import("../server/push/contacts");
const { parseServiceAccount, setPhoneVerifier, demoOtpEnabled } = await import("../server/firebase");

setContactsPepper("test-pepper");
let pass = 0;
let fail = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "\n   ", (e as Error).message);
  }
}

function setup() {
  let now = Date.parse("2026-10-06T18:00:00Z");
  const names: Record<string, string> = { a: "Ana", b: "Ben", c: "Cy", d: "Dee", e: "Eve", h: "Host" };
  const follows: Record<string, string[]> = {}; // follower -> following
  const fg = new Set<string>();
  const phones: [string, string][] = [["b", "+14155550111"]];
  const repo = new MemoryPushRepo();
  const sender = new MemorySender();
  const n = new Notifier({
    repo,
    sender,
    isForeground: (id) => fg.has(id),
    userName: (id) => names[id] ?? null,
    followerIds: (id) => Object.keys(follows).filter((f) => follows[f].includes(id)),
    followingIds: (id) => follows[id] ?? [],
    usersWithPhones: () => phones,
    now: () => now,
  });
  const tok = async (u: string, p = "android") => repo.upsertToken({ token: `tok_${u}_${p}_xxxxxxxxxxxxxxxxxxxx`, userId: u, platform: p as never });
  return { n, repo, sender, follows, fg, phones, tok, adv: (ms: number) => (now += ms) };
}

console.log("push tests");

await t("prefs: defaults, merge, junk ignored", () => {
  const p = mergePrefs(null, { dm: false, bogus: 1, quietHours: { start: "22:00", end: "07:00", tz: "America/Phoenix" } });
  assert.equal(p.dm, false);
  assert.equal(p.roomInvite, true);
  assert.equal((p as never as Record<string, unknown>).bogus, undefined);
  assert.deepEqual(p.quietHours, { start: "22:00", end: "07:00", tz: "America/Phoenix" });
  assert.equal(mergePrefs(p, { quietHours: { start: "9", end: "x", tz: "Nope/Zone" } }).quietHours?.start, "22:00");
  assert.equal(DEFAULT_PREFS.contactsOptIn, false);
});

await t("quiet hours wrap midnight in the user's zone", () => {
  const q = { start: "22:00", end: "07:00", tz: "America/Phoenix" };
  assert.equal(inQuietHours(q, Date.parse("2026-10-07T06:30:00Z")), true); // 23:30 Phoenix
  assert.equal(inQuietHours(q, Date.parse("2026-10-06T20:00:00Z")), false); // 13:00
  assert.equal(inQuietHours(null), false);
});

await t("DM: pushed when recipient backgrounded, skipped in foreground, collapsed per thread", async () => {
  const s = setup();
  await s.tok("b");
  assert.equal(await s.n.dm({ fromId: "a", toId: "b", text: "hi", fromName: "Ana" }), "sent");
  const m = s.sender.sent[0].msg;
  assert.equal(m.tag, "dm:a");
  assert.equal(m.url, "/messages/a");
  assert.equal(m.channel, "messages");
  s.fg.add("b");
  assert.equal(await s.n.dm({ fromId: "a", toId: "b", text: "again", fromName: "Ana" }), "skip:foreground");
});

await t("DM read clears notification on reader devices", async () => {
  const s = setup();
  await s.tok("b");
  await s.n.dmRead("b", "a");
  assert.equal(s.sender.sent[0].msg.clear, true);
  assert.equal(s.sender.sent[0].msg.tag, "dm:a");
});

await t("DM pref off → skipped; no tokens → no-tokens", async () => {
  const s = setup();
  assert.equal(await s.n.dm({ fromId: "a", toId: "b", text: "x", fromName: "Ana" }), "no-tokens");
  await s.tok("b");
  await s.n.updatePrefs("b", { dm: false });
  assert.equal(await s.n.dm({ fromId: "a", toId: "b", text: "x", fromName: "Ana" }), "skip:pref");
});

await t("invite to speak → roomInvite push with room deep link, deduped", async () => {
  const s = setup();
  await s.tok("b");
  assert.equal(await s.n.inviteToSpeak("r1", "Late night", "h", "b"), "sent");
  assert.equal(s.sender.sent[0].msg.url, "/room/r1");
  assert.equal(s.sender.sent[0].msg.data?.roomId, "r1");
  assert.equal(await s.n.inviteToSpeak("r1", "Late night", "h", "b"), "skip:dedupe");
});

await t("ping → roomInvite push; ignores quiet hours", async () => {
  const s = setup();
  await s.tok("b");
  await s.n.updatePrefs("b", { quietHours: { start: "00:00", end: "23:59", tz: "UTC" } });
  assert.equal(await s.n.ping("r1", "Room", "a", "b"), "sent");
  assert.equal(s.sender.sent[0].msg.type, "roomPing");
});

await t("followed user starts a room → followers; active-rooms throttle 1/10min; quiet hours respected", async () => {
  const s = setup();
  s.follows.b = ["h", "a"];
  s.follows.c = ["h"];
  await s.tok("b");
  await s.tok("c");
  await s.n.updatePrefs("c", { quietHours: { start: "00:00", end: "23:59", tz: "UTC" } });
  const r = await s.n.roomStarted("r1", "Morning", "h");
  assert.equal(r.b, "sent");
  assert.equal(r.c, "skip:quiet");
  const r2 = await s.n.roomStarted("r2", "Another", "a");
  assert.equal(r2.b, "skip:throttle");
  s.adv(ACTIVE_ROOM_INTERVAL_MS + 1);
  assert.equal((await s.n.roomStarted("r3", "Later", "a")).b, "sent");
});

await t("followed user joins a room; ≥3 followed in room → trending push", async () => {
  const s = setup();
  s.follows.e = ["a", "b", "c"];
  await s.tok("e");
  const out = await s.n.roomJoined({ id: "r9", title: "Jazz", hostId: "h", participantIds: ["h", "a", "b", "c"] }, "c");
  assert.equal(out.e, "sent");
  assert.equal(s.sender.sent[0].msg.type, "trendingRoom");
  const s2 = setup();
  s2.follows.e = ["a"];
  await s2.tok("e");
  await s2.n.roomJoined({ id: "r9", title: "Jazz", hostId: "h", participantIds: ["h", "a"] }, "a");
  assert.equal(s2.sender.sent[0].msg.type, "followedRoom");
});

await t("room you were in recently is live again (recentRoom, opt-in)", async () => {
  const s = setup();
  await s.tok("d");
  await s.n.updatePrefs("d", { recentRoom: true });
  await s.n.roomJoined({ id: "r1", title: "Old", hostId: "h", participantIds: ["h", "d"] }, "d");
  s.adv(3600_000);
  assert.equal((await s.n.roomStarted("r2", "New", "h")).d, "sent");
  assert.equal(s.sender.sent.at(-1)?.msg.type, "recentRoom");
});

await t("scheduled room starting → RSVPs", async () => {
  const s = setup();
  await s.tok("b");
  assert.equal((await s.n.scheduledRoomStarting("r5", "AMA", ["b"])).b, "sent");
});

await t("new followers: first immediate, rest collapsed into one push", async () => {
  const s = setup();
  await s.tok("h");
  assert.equal(await s.n.newFollower("h", "a"), "sent");
  assert.equal(s.n.newFollower("h", "b"), null);
  assert.equal(s.n.newFollower("h", "c"), null);
  assert.equal(s.n.newFollower("h", "d"), null);
  s.adv(FOLLOWER_BATCH_MS);
  assert.equal(await s.n.flushFollowers("h"), "sent");
  const m = s.sender.sent.at(-1)!.msg;
  assert.equal(m.body, "Ben, Cy and 1 other followed you");
  assert.equal(m.tag, "followers");
});

await t("hourly cap stops spam", async () => {
  const s = setup();
  await s.tok("b");
  let sent = 0;
  for (let i = 0; i < HOURLY_CAP + 5; i++) if ((await s.n.inviteToSpeak(`r${i}`, "x", "h", "b")) === "sent") sent++;
  assert.equal(sent, HOURLY_CAP);
});

await t("invalid tokens are pruned", async () => {
  const s = setup();
  await s.tok("b");
  await s.tok("b", "ios");
  s.sender.invalid.add("tok_b_ios_xxxxxxxxxxxxxxxxxxxx");
  await s.n.inviteToSpeak("r1", "x", "h", "b");
  assert.deepEqual((await s.repo.tokensFor("b")).map((x) => x.platform), ["android"]);
});

await t("token register validation", async () => {
  const s = setup();
  assert.equal((await s.n.registerToken("a", "short", "android")).ok, false);
  assert.equal((await s.n.registerToken("a", "x".repeat(100), "android")).ok, true);
  await s.n.unregisterToken("b", "x".repeat(100)); // someone else's token: untouched
  assert.equal((await s.repo.tokensFor("a")).length, 1);
});

await t("contacts: requires opt-in; matches members; stores only peppered unmatched hashes; contact-joined push", async () => {
  const s = setup();
  const bHash = clientHash("+14155550111");
  const strangerHash = clientHash("+14155550199");
  assert.equal((await s.n.matchContacts("a", [bHash])).ok, false);
  await s.n.updatePrefs("a", { contactsOptIn: true });
  const r = await s.n.matchContacts("a", [bHash, strangerHash, "junk"]);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.userIds, ["b"]);
  const stored = [...s.repo.hashes.get("a")!.set];
  assert.deepEqual(stored, [pepperHash(strangerHash)]);
  assert.ok(!stored.includes(strangerHash), "raw client hash never stored");
  await s.tok("a");
  const j = await s.n.contactJoined("newbie", "+14155550199");
  assert.equal(j.a, "sent");
  assert.equal(s.sender.sent[0].msg.type, "contactJoined");
});

await t("contacts: opting out deletes uploaded hashes; 24h auto-purge", async () => {
  const s = setup();
  await s.n.updatePrefs("a", { contactsOptIn: true });
  await s.n.matchContacts("a", [clientHash("+15550000000")]);
  assert.equal(await s.repo.purgeExpiredHashes(Date.now() + 25 * 3600_000), 1);
  await s.n.matchContacts("a", [clientHash("+15550000000")]);
  await s.n.updatePrefs("a", { contactsOptIn: false });
  assert.equal(s.repo.hashes.has("a"), false);
});

await t("service account parse: raw JSON, base64, junk", () => {
  const sa = { project_id: "p", client_email: "e@x", private_key: "k" };
  assert.equal(parseServiceAccount(JSON.stringify(sa))?.project_id, "p");
  assert.equal(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString("base64"))?.client_email, "e@x");
  assert.equal(parseServiceAccount("nope"), null);
  assert.equal(parseServiceAccount(undefined), null);
});

await t("DEMO_OTP_ENABLED default on, can be turned off", () => {
  delete process.env.DEMO_OTP_ENABLED;
  assert.equal(demoOtpEnabled(), true);
  process.env.DEMO_OTP_ENABLED = "false";
  assert.equal(demoOtpEnabled(), false);
  delete process.env.DEMO_OTP_ENABLED;
});

await t("firebase phone login: verified token → existing user session / new user ticket; rejected token", async () => {
  const { store } = await import("../server/store");
  await store.init();
  const { firebasePhoneLogin } = await import("../server/realtime");
  const { getTicket } = await import("../server/authx/signup");
  const acct = store.createAccount("+14155550123", { firstName: "Fire", username: "firetest" });
  assert.ok(acct.ok);
  setPhoneVerifier(async (tok) => (tok === "good-existing" ? { ok: true, phone: "+14155550123", uid: "f1" } : tok === "good-new" ? { ok: true, phone: "+14155550777", uid: "f2" } : { ok: false, error: "bad" }));
  const r1 = await firebasePhoneLogin("good-existing", "test");
  assert.ok(r1.ok && r1.status === "existing");
  if (r1.ok && r1.status === "existing") {
    assert.equal(r1.userId, acct.ok && acct.user.id);
    assert.ok(r1.creds.access && r1.creds.refresh);
    const a = await store.authenticate(r1.creds.access);
    assert.ok(a.ok);
  }
  const r2 = await firebasePhoneLogin("good-new", "test");
  assert.ok(r2.ok && r2.status === "new");
  if (r2.ok && r2.status === "new") { const tk = getTicket(r2.ticket); assert.equal(tk?.kind === "phone" ? tk.phone : null, "+14155550777"); }
  assert.equal((await firebasePhoneLogin("forged", "test")).ok, false);
  setPhoneVerifier(null);
  // real verifier without Firebase configured refuses
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  assert.equal((await firebasePhoneLogin("x".repeat(50), "test")).ok, false);
  await store.close();
});

console.log(fail ? `FAILED (${fail} failed, ${pass} passed)` : `PASSED (${pass})`);
process.exit(fail ? 1 : 0);
}
void main();
