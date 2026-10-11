// Unit tests: notification triggers + gates, prefs, contacts hashing, Firebase phone login. Run: npm run test:push
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ol-push-"));
delete process.env.DATABASE_URL;
process.env.DEMO_SEED = "0";

async function main() {
const { Notifier, ACTIVE_ROOM_INTERVAL_MS, FOLLOWER_BATCH_MS, HOURLY_CAP, LIVE_COPY } = await import("../server/push/notifier");
const { MemoryLiveInbox, LIVE_INBOX_MAX } = await import("../server/push/liveInbox");
const { runTrendingLive, pickTrendingRoom, isoWeek, TRENDING_LIVE_MIN_PEOPLE } = await import("../server/push/trendingLive");
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

await t("new people: 'Tell me when contacts join' keeps codes past 24 h; off erases them; opt-out forces it off", async () => {
  const s = setup();
  await s.n.updatePrefs("a", { contactsOptIn: true, contactsKeep: true });
  await s.n.matchContacts("a", [clientHash("+15550000001")]);
  assert.equal(s.repo.hashes.get("a")!.keep, true);
  assert.equal(await s.repo.purgeExpiredHashes(Date.now() + 30 * 24 * 3600_000), 0, "kept rows survive the purge");
  assert.deepEqual(await s.repo.ownersOfHash(pepperHash(clientHash("+15550000001"))), ["a"]);
  await s.n.updatePrefs("a", { contactsKeep: false });
  assert.equal(s.repo.hashes.has("a"), false, "switch off → erased right away");
  // switching on later flips the current upload to kept
  await s.n.matchContacts("a", [clientHash("+15550000002")]);
  assert.equal(s.repo.hashes.get("a")!.keep, false);
  await s.n.updatePrefs("a", { contactsKeep: true });
  assert.equal(s.repo.hashes.get("a")!.keep, true);
  const off = await s.n.updatePrefs("a", { contactsOptIn: false });
  assert.equal(off.contactsKeep, false);
  assert.equal(s.repo.hashes.has("a"), false);
  assert.equal(mergePrefs(null, { contactsKeep: true }).contactsKeep, false, "can't keep without contacts on");
});

await t("new people: 'Maya just joined Open Lounge' — push when away, in-app banner (no push) when the app is open", async () => {
  const s = setup();
  const shown: { uid: string; n: { type: string; title: string; actorId?: string; url: string } }[] = [];
  const online = new Set<string>();
  (s.n as unknown as { d: { inApp: unknown } }).d.inApp = (uid: string, n: never) => (online.has(uid) ? (shown.push({ uid, n }), true) : false);
  for (const u of ["a", "c"]) {
    await s.n.updatePrefs(u, { contactsOptIn: true });
    await s.n.matchContacts(u, [clientHash("+14155550199")]);
    await s.tok(u);
  }
  online.add("c");
  s.fg.add("c");
  const r = await s.n.contactJoined("newbie", "+14155550199");
  assert.equal(r.a, "sent");
  assert.equal(r.c, "in-app");
  assert.equal(s.sender.sent.length, 1, "no device push while the app is open");
  assert.match(s.sender.sent[0].msg.title, /just joined Open Lounge/);
  assert.equal(shown[0].uid, "c");
  assert.equal(shown[0].n.type, "contactJoined");
  assert.equal(shown[0].n.actorId, "newbie");
  assert.equal(shown[0].n.url, "/profile/newbie");
  // dedupe: the same person never announced twice
  const again = await s.n.contactJoined("newbie", "+14155550199");
  assert.equal(again.a, "skip:dedupe");
  assert.equal(again.c, "skip:dedupe");
  // pref off → nothing anywhere
  const s2 = setup();
  (s2.n as unknown as { d: { inApp: unknown } }).d.inApp = () => true;
  await s2.n.updatePrefs("a", { contactsOptIn: true, contactJoined: false });
  await s2.n.matchContacts("a", [clientHash("+14155550198")]);
  assert.equal((await s2.n.contactJoined("x", "+14155550198")).a, "skip:pref");
  // web-only member (no device token) with a hidden tab still gets the in-app copy (OS notification on the web)
  const s3 = setup();
  let hit = 0;
  (s3.n as unknown as { d: { inApp: unknown } }).d.inApp = () => (hit++, true);
  await s3.n.updatePrefs("a", { contactsOptIn: true });
  await s3.n.matchContacts("a", [clientHash("+14155550197")]);
  assert.equal((await s3.n.contactJoined("y", "+14155550197")).a, "in-app");
  assert.equal(hit, 1);
});

await t("live activity: room started / joined → in-app banner while open (no push), push when away; throttle shared; blocks respected", async () => {
  const s = setup();
  const shown: { uid: string; n: { type: string; roomId?: string; actorId?: string } }[] = [];
  const online = new Set<string>(["a"]);
  const blocks = new Set<string>(["c|h"]);
  const d = (s.n as unknown as { d: Record<string, unknown> }).d;
  d.inApp = (uid: string, n: never) => (online.has(uid) ? (shown.push({ uid, n }), true) : false);
  d.blocked = (x: string, y: string) => blocks.has(`${x}|${y}`) || blocks.has(`${y}|${x}`);
  s.follows.a = ["h"];
  s.follows.b = ["h"];
  s.follows.c = ["h"];
  for (const u of ["a", "b", "c"]) await s.tok(u);
  s.fg.add("a");
  const r = await s.n.roomStarted("r1", "Late night jazz", "h");
  assert.equal(r.a, "in-app");
  assert.equal(r.b, "sent");
  assert.equal(r.c, "skip:blocked");
  assert.equal(s.sender.sent.length, 1);
  assert.equal(s.sender.sent[0].tokens[0].userId, "b");
  assert.deepEqual([shown[0].uid, shown[0].n.type, shown[0].n.roomId, shown[0].n.actorId], ["a", "followedRoom", "r1", "h"]);
  // the 1-per-10-min active-room throttle covers the in-app copy too
  s.adv(60_000);
  const j = await s.n.roomJoined({ id: "r2", title: "Other", hostId: "z", participantIds: ["z", "h"] }, "h");
  assert.equal(j.a, "skip:throttle");
  s.adv(10 * 60_000);
  const j2 = await s.n.roomJoined({ id: "r2", title: "Other", hostId: "z", participantIds: ["z", "h"] }, "h");
  assert.equal(j2.a, "in-app");
  assert.equal(shown.at(-1)!.n.actorId, "h");
  // a hidden tab (online, not foreground) gets the in-app copy AND the device push
  s.fg.delete("a");
  s.adv(11 * 60_000);
  const before = s.sender.sent.length;
  const r3 = await s.n.roomStarted("r3", "Morning", "h");
  assert.equal(r3.a, "sent");
  assert.equal(shown.at(-1)!.n.roomId, "r3");
  assert.ok(s.sender.sent.slice(before).some((x) => x.tokens[0].userId === "a"));
});

await t("live copy: Clubhouse wording on push and in-app — started / joined / speaking / scheduled / live again", async () => {
  const s = setup();
  const shown: { uid: string; n: { title: string; body: string } }[] = [];
  const d = (s.n as unknown as { d: Record<string, unknown> }).d;
  d.inApp = (uid: string, n: never) => (shown.push({ uid, n }), true);
  s.follows.b = ["h"];
  await s.tok("b");
  await s.n.roomStarted("r1", "Late night jazz", "h");
  const m = s.sender.sent[0].msg;
  assert.equal(m.title, "Host started a room");
  assert.equal(m.body, "Late night jazz · tap to join");
  assert.deepEqual([shown[0].n.title, shown[0].n.body], [m.title, m.body], "in-app banner = device push copy");
  const s2 = setup();
  s2.follows.b = ["a"];
  await s2.tok("b");
  await s2.n.roomJoined({ id: "r2", title: "AMA", hostId: "h", participantIds: ["h", "a"] }, "a");
  assert.equal(s2.sender.sent[0].msg.title, "Ana joined a room");
  assert.equal(s2.sender.sent[0].msg.body, "AMA · tap to join");
  const s3 = setup();
  s3.follows.b = ["c"];
  await s3.tok("b");
  assert.equal((await s3.n.roomSpeaking({ id: "r3", title: "Design", hostId: "h", participantIds: ["h", "c"] }, "c")).b, "sent");
  assert.equal(s3.sender.sent[0].msg.title, "Cy is speaking");
  assert.equal(s3.sender.sent[0].msg.url, "/room/r3");
  const s4 = setup();
  await s4.tok("b");
  await s4.n.scheduledRoomStarting("r4", "Weekly sync", ["b"], "h");
  assert.equal(s4.sender.sent[0].msg.title, "Host's room is live now");
  assert.equal(s4.sender.sent[0].msg.body, "Weekly sync · tap to join");
  assert.match(LIVE_COPY.body("x".repeat(200)), /^x{89}… · tap to join$/, "long titles clipped");
  assert.equal(LIVE_COPY.body(""), "Untitled room · tap to join");
});

await t("speaking: already told about the room → no second notice; people in the room and blocks skipped", async () => {
  const s = setup();
  const blocks = new Set<string>(["d|c"]);
  (s.n as unknown as { d: Record<string, unknown> }).d.blocked = (x: string, y: string) => blocks.has(`${x}|${y}`) || blocks.has(`${y}|${x}`);
  s.follows.b = ["c"];
  s.follows.d = ["c"];
  s.follows.e = ["c"];
  for (const u of ["b", "d", "e"]) await s.tok(u);
  await s.n.roomJoined({ id: "r1", title: "Room", hostId: "h", participantIds: ["h", "c"] }, "c");
  s.adv(ACTIVE_ROOM_INTERVAL_MS + 1);
  const r = await s.n.roomSpeaking({ id: "r1", title: "Room", hostId: "h", participantIds: ["h", "c", "e"] }, "c");
  assert.equal(r.b, "skip:dedupe");
  assert.equal(r.d, "skip:blocked");
  assert.equal(r.e, undefined, "already in the room");
});

await t("Live now inbox: kept even when the banner/push is held back; one entry per room; read state; auto-clear on room end", async () => {
  const s = setup();
  const inbox = new MemoryLiveInbox();
  const changed: string[] = [];
  const d = (s.n as unknown as { d: Record<string, unknown> }).d;
  d.inbox = inbox;
  d.inboxChanged = (uid: string, n: { roomId: string }) => changed.push(`${uid}:${n.roomId}`);
  s.follows.b = ["h", "a"];
  s.follows.c = ["h"];
  await s.tok("b");
  await s.n.updatePrefs("c", { quietHours: { start: "00:00", end: "23:59", tz: "UTC" } });
  await s.n.roomStarted("r1", "Morning", "h");
  s.adv(1000);
  assert.equal((await s.n.roomStarted("r2", "Another", "a")).b, "skip:throttle");
  const b = await inbox.list("b");
  assert.deepEqual(b.map((x) => x.roomId), ["r2", "r1"], "throttled notice still in the inbox, newest first");
  assert.equal(b[1].title, "Host started a room");
  assert.equal(b[1].actorId, "h");
  assert.equal(b[1].readAt, null);
  assert.deepEqual((await inbox.list("c")).map((x) => x.roomId), ["r1"], "quiet hours: silent inbox entry, no buzz");
  assert.deepEqual(changed, ["b:r1", "c:r1", "b:r2"]);
  // pref off → nothing, not even the inbox
  await s.n.updatePrefs("c", { followedRoom: false });
  s.adv(1000);
  await s.n.roomStarted("r3", "Off", "h");
  assert.equal((await inbox.list("c")).length, 1);
  // read state
  assert.equal(await inbox.markRead("b", ["r1"], 5), 1);
  assert.equal((await inbox.list("b")).find((x) => x.roomId === "r1")?.readAt, 5);
  assert.equal(await inbox.markRead("b", null, 6), 2);
  // room ends → entries gone for everyone who had one
  assert.deepEqual((await s.n.roomEnded("r1")).sort(), ["b", "c"]);
  assert.deepEqual((await inbox.list("b")).map((x) => x.roomId), ["r3", "r2"]);
  // cap per user
  for (let i = 0; i < LIVE_INBOX_MAX + 5; i++) await inbox.add("z", { roomId: `x${i}`, type: "followedRoom", actorId: null, title: "t", body: "b", url: "/", at: i });
  const z = await inbox.list("z");
  assert.equal(z.length, LIVE_INBOX_MAX);
  assert.equal(z.at(-1)?.roomId, "x5");
  // account deletion wipes it
  await s.n.deleteUserData("b");
  assert.equal((await inbox.list("b")).length, 0);
});

await t("trending live: ISO week, room pick (most people, ≥5, public, not seeded)", () => {
  assert.equal(isoWeek(Date.parse("2026-10-10T12:00:00Z")), "2026-W41");
  assert.equal(isoWeek(Date.parse("2027-01-01T12:00:00Z")), "2026-W53");
  assert.equal(isoWeek(Date.parse("2026-01-01T00:00:00Z")), "2026-W01");
  const ppl = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  assert.equal(pickTrendingRoom([{ id: "a", title: "", hostId: "h", participantIds: ppl(TRENDING_LIVE_MIN_PEOPLE - 1) }]), null);
  const pick = pickTrendingRoom([
    { id: "s", title: "", hostId: "h", participantIds: ppl(50), seeded: true },
    { id: "p", title: "", hostId: "h", participantIds: ppl(40), private: true },
    { id: "b", title: "", hostId: "h", participantIds: ppl(8) },
    { id: "a", title: "", hostId: "h", participantIds: ppl(8) },
    { id: "c", title: "", hostId: "h", participantIds: ppl(6) },
  ]);
  assert.equal(pick?.id, "a");
});

await t("trending live: once per user per week, non-followers only, blocks/prefs/quiet hours respected, idempotent across runs", async () => {
  const s = setup();
  const inbox = new MemoryLiveInbox();
  (s.n as unknown as { d: Record<string, unknown> }).d.inbox = inbox;
  const blocks = new Set<string>(["e|h"]);
  const room = { id: "big", title: "Founders AMA", hostId: "h", participantIds: ["h", "p1", "p2", "p3", "p4"] };
  s.follows.a = ["h"]; // follower → followedRoom covers it
  for (const u of ["a", "b", "c", "d", "e"]) await s.tok(u);
  await s.n.updatePrefs("c", { trendingLive: false });
  await s.n.updatePrefs("d", { quietHours: { start: "00:00", end: "23:59", tz: "UTC" } });
  const deps = {
    notifier: s.n,
    inbox,
    liveRooms: () => [room],
    userIds: () => ["h", "p1", "a", "b", "c", "d", "e"],
    followingIds: (id: string) => s.follows[id] ?? [],
    blocked: (x: string, y: string) => blocks.has(`${x}|${y}`) || blocks.has(`${y}|${x}`),
    now: () => s.adv(0),
  };
  const r1 = await runTrendingLive(deps);
  assert.equal(r1.roomId, "big");
  assert.equal(r1.out.a, undefined, "followers skipped");
  assert.equal(r1.out.p1, undefined, "people in the room skipped");
  assert.equal(r1.out.b, "sent");
  assert.equal(r1.out.c, "skip:pref");
  assert.equal(r1.out.d, "skip:quiet");
  assert.equal(r1.out.e, "skip:blocked");
  const m = s.sender.sent.find((x) => x.tokens[0].userId === "b")!.msg;
  assert.equal(m.type, "trendingLive");
  assert.equal(m.title, "Trending live");
  assert.equal(m.body, "Host · Founders AMA · 5 listening · tap to join");
  assert.equal(m.url, "/room/big");
  assert.deepEqual((await inbox.list("b")).map((x) => x.type), ["trendingLive"]);
  // same week: nobody gets a second pick, even for another room or after a restart (claim lives in the store)
  s.adv(3 * 3600_000);
  room.id = "big2";
  const r2 = await runTrendingLive(deps);
  assert.equal(r2.out.b, "skip:week");
  // quiet hours ended → the released claim lets them get this week's pick later
  await s.n.updatePrefs("d", { quietHours: null });
  assert.equal(r2.out.d, "skip:quiet");
  const r3 = await runTrendingLive(deps);
  assert.equal(r3.out.d, "sent");
  // next ISO week → eligible again
  s.adv(7 * 24 * 3600_000);
  room.id = "big3";
  assert.equal((await runTrendingLive(deps)).out.b, "sent");
  // no room big enough → nothing at all
  const before = s.sender.sent.length;
  const small = await runTrendingLive({ ...deps, liveRooms: () => [{ ...room, participantIds: ["h"] }] });
  assert.equal(small.roomId, null);
  assert.equal(s.sender.sent.length, before);
  assert.equal(DEFAULT_PREFS.trendingLive, true, "on by default");
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
