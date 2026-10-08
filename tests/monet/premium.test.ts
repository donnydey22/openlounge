// Premium: flag gate, one-time passes through the sticker PayPal pipeline, stacking, refunds, restore,
// auto-renew subscriptions (mocked Subscriptions API + webhooks), perks (packs, badge, limits, icons, early).
// Run via `npm run test:monet` (sets DATA_DIR to a temp dir).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStickerRepo } from "../../server/stickers/repo";
import { StickerService, setStickerService } from "../../server/stickers/service";
import { createPack, updatePack, addSticker } from "../../server/stickers/admin";
import { useMemoryDb } from "../../server/monet/db";
import { PremiumService, setPremiumService } from "../../server/premium/service";
import { badgesOf } from "../../server/monet/router";
import { stickerText } from "../../src/lib/stickers/token";
import { fakePayPal, hook, PAID_ENV } from "./fake-paypal";

useMemoryDb(true);
const ON = { ...PAID_ENV, PREMIUM_ENABLED: "1" };

async function setup(env: Record<string, string> = ON) {
  const pp = fakePayPal();
  const mails: any[] = [];
  const svc = new StickerService({ repo: new MemoryStickerRepo(), env, fetchFn: pp.fetchFn, mailer: async (m) => (mails.push(m), true), users: { email: () => "me@example.com", name: () => "Me", exists: () => true } });
  setStickerService(svc);
  await svc.init();
  const prem = new PremiumService(env);
  setPremiumService(prem);
  await prem.init();
  return { svc, prem, pp, mails };
}
beforeEach(() => {
  setStickerService(null);
  setPremiumService(null);
});

test("flag off (default): no checkout, no perks, config says disabled", async () => {
  const { svc, prem } = await setup({ ...PAID_ENV });
  assert.equal(prem.config().enabled, false);
  assert.equal(prem.config().checkout, false);
  const r = await svc.createCheckout("u1", "premium:month", "paypal");
  assert.equal((r as any).status, 503);
  await prem.grant("u1", "admin-1", "month", "grant");
  assert.equal(prem.isPremium("u1"), false, "perks only while Premium is on");
  assert.deepEqual(prem.limitsFor("u1").fileExpiryDays, [1, 7]);
});

test("one-time pass: Open Lounge order, grant on capture, one receipt, stacking, perks", async () => {
  const { svc, prem, pp, mails } = await setup();
  const c = await svc.createCheckout("u1", "premium:month", "paypal");
  assert.ok(c.ok);
  const req = pp.orders.get(c.orderId).request;
  assert.equal(req.purchase_units[0].amount.value, "4.99");
  assert.match(req.purchase_units[0].items[0].name, /Open Lounge Premium \(1 month\)/);
  assert.equal(req.purchase_units[0].items[0].category, "DIGITAL_GOODS");
  assert.equal(req.payment_source.paypal.experience_context.brand_name, "Open Lounge");
  assert.ok(!JSON.stringify(req).includes("Sumeet"));
  assert.equal(((await svc.createCheckout("u1", "premium:week", "paypal")) as any).status, 404);
  assert.equal(((await svc.createCheckout("u1", "premium:month", "paypal", { wrapper: true })) as any).status, 403, "never sold in the apps");
  const a = await svc.capture("u1", c.orderId);
  assert.ok(a.ok);
  assert.equal(prem.isPremium("u1"), true);
  const end1 = prem.endOf("u1");
  assert.ok(end1 > Date.now() + 30 * 86_400_000);
  await svc.capture("u1", c.orderId);
  await svc.restore("u1");
  assert.equal(prem.endOf("u1"), end1, "capture/restore are idempotent");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Open Lounge Premium \(1 month\)/);
  assert.match(mails[0].text, /Manage it here: .*\/premium/);
  // buying a year while active extends from the current end
  const y = await svc.createCheckout("u1", "premium:year", "paypal");
  assert.ok(y.ok);
  await svc.capture("u1", y.orderId);
  assert.ok(prem.endOf("u1") >= end1 + 365 * 86_400_000);
  // perks
  assert.deepEqual(prem.limitsFor("u1"), { uploadMaxMB: 200, fileExpiryDays: [1, 7, 30, 90] });
  assert.equal(prem.limitsFor("u2").uploadMaxMB, 25);
  assert.equal(prem.isEarly("u1", "stage-reactions"), true);
  assert.equal(prem.isEarly("u2", "stage-reactions"), false);
  assert.deepEqual(badgesOf("u1"), { premium: true });
  assert.deepEqual(badgesOf("u2"), {});
  const me = prem.me("u1");
  assert.equal(me.active, true);
  assert.equal(me.source, "order");
});

test("refund webhook revokes that pass", async () => {
  const { svc, prem } = await setup();
  const c = await svc.createCheckout("u1", "premium:month", "paypal");
  assert.ok(c.ok);
  await svc.capture("u1", c.orderId);
  assert.equal(prem.isPremium("u1"), true);
  const [h, raw] = hook("E-R1", "PAYMENT.CAPTURE.REFUNDED", { id: "RF1", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/CAP-${c.orderId}` }] });
  assert.equal((await svc.webhook(h, raw)).status, 200);
  assert.equal(prem.isPremium("u1"), false);
});

test("premium sticker packs: hidden while off, included for members, never sold, send-gated", async () => {
  const { svc, prem } = await setup();
  const made = await createPack(svc, "admin", { title: "Gold Cats", emoji: "🐱", premium: true, priceCents: 199 });
  assert.ok(made.ok);
  assert.equal(made.pack.priceCents, null, "premium packs carry no price");
  const png = "data:image/png;base64," + (await (await import("sharp")).default({ create: { width: 64, height: 64, channels: 4, background: "#fc0" } }).png().toBuffer()).toString("base64");
  const add = await addSticker(svc, "admin", made.pack.id, { emoji: "🐱", file: png });
  assert.ok(add.ok);
  await updatePack(svc, "admin", made.pack.id, { published: true });
  const text = stickerText({ packId: made.pack.id, stickerId: add.sticker.id, emoji: "🐱" } as any);
  assert.match(svc.sendError("u1", text)!, /Premium members/);
  assert.equal(((await svc.createCheckout("u1", made.pack.id, "paypal")) as any).status, 400);
  await prem.grant("u1", "admin-x", "month", "grant");
  assert.equal(svc.sendError("u1", text), null);
  assert.ok((await svc.mine("u1")).owned.includes(made.pack.id));
  // Premium switched off → pack hidden from the catalog
  const off = new PremiumService({ ...PAID_ENV });
  svc.premiumVisible = () => off.enabled;
  assert.equal(svc.pack(made.pack.id), null);
  assert.ok(!svc.list().some((p) => p.id === made.pack.id));
});

test("prefs: premium icons need membership, badge can be hidden", async () => {
  const { prem } = await setup();
  assert.equal((await prem.setPrefs("u1", { appIcon: "midnight" })).ok, false);
  assert.equal((await prem.setPrefs("u1", { appIcon: "nope" })).ok, false);
  assert.ok((await prem.setPrefs("u1", { appIcon: "classic" })).ok);
  await prem.grant("u1", "admin-1", "month", "grant");
  const r = await prem.setPrefs("u1", { appIcon: "midnight", badgeVisible: false });
  assert.ok(r.ok && r.me.prefs.appIcon === "midnight");
  assert.deepEqual(badgesOf("u1"), {});
});

test("auto-renew: needs plan ids; subscribe → approve link; sync grants first period; sale webhook replaces it; renewals stack; cancel", async () => {
  const { prem } = await setup();
  assert.deepEqual(prem.config().subscriptions, []);
  assert.equal((await prem.subscribe("u1", "month")).ok, false);
  const env = { ...ON, PAYPAL_PREMIUM_PLAN_MONTH: "P-MONTH" };
  const { prem: p2, pp, svc } = await setup(env);
  assert.deepEqual(p2.config().subscriptions, ["month"]);
  assert.equal(((await p2.subscribe("u1", "month", { wrapper: true })) as any).status, 403);
  const s = await p2.subscribe("u1", "month");
  assert.ok(s.ok && s.approveUrl!.includes("sandbox.paypal.com"));
  const req = pp.subs.get(s.subscriptionId).request;
  assert.equal(req.plan_id, "P-MONTH");
  assert.equal(req.application_context.brand_name, "Open Lounge");
  assert.equal(p2.isPremium("u1"), false, "nothing until PayPal says ACTIVE");
  assert.equal(((await p2.syncSubscription("u2", s.subscriptionId)) as any).status, 404);
  pp.subs.get(s.subscriptionId).status = "ACTIVE";
  const sy = await p2.syncSubscription("u1", s.subscriptionId);
  assert.ok(sy.ok && sy.me.active && sy.me.autoRenew);
  const end1 = p2.endOf("u1");
  // first sale webhook replaces the provisional grant (no double period)
  let [h, raw] = hook("E-S1", "PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: s.subscriptionId });
  assert.equal((await svc.webhook(h, raw)).status, 200);
  assert.equal(p2.endOf("u1"), end1);
  // renewal stacks
  [h, raw] = hook("E-S2", "PAYMENT.SALE.COMPLETED", { id: "SALE-2", billing_agreement_id: s.subscriptionId });
  await svc.webhook(h, raw);
  assert.ok(p2.endOf("u1") > end1 + 30 * 86_400_000);
  // refund of a renewal sale revokes it
  [h, raw] = hook("E-S3", "PAYMENT.SALE.REFUNDED", { id: "RF-2", sale_id: "SALE-2" });
  await svc.webhook(h, raw);
  assert.equal(p2.endOf("u1"), end1);
  // status webhooks
  [h, raw] = hook("E-S4", "BILLING.SUBSCRIPTION.SUSPENDED", { id: s.subscriptionId, status: "SUSPENDED" });
  await svc.webhook(h, raw);
  assert.equal(p2.me("u1").autoRenew, false);
  pp.subs.get(s.subscriptionId).status = "ACTIVE";
  await p2.syncSubscription("u1", s.subscriptionId);
  const c = await p2.cancel("u1");
  assert.ok(c.ok);
  assert.equal(pp.subs.get(s.subscriptionId).status, "CANCELLED");
  assert.equal(c.me.autoRenew, false);
  assert.equal(c.me.active, true, "paid time runs to the end");
});

test("admin comps: grant + revoke only touch complimentary time", async () => {
  const { prem, svc } = await setup();
  const { store } = await import("../../server/store");
  const uid = [...store.users.keys()][0] ?? "nobody";
  if (uid === "nobody") return; // no seeded users in this environment
  assert.equal((await prem.adminGrant("admin", { userId: "missing" })).ok, false);
  const c = await svc.createCheckout(uid, "premium:month", "paypal");
  assert.ok(c.ok);
  await svc.capture(uid, c.orderId);
  const paidEnd = prem.endOf(uid);
  const g = await prem.adminGrant("admin", { userId: uid, plan: "month" });
  assert.ok(g.ok && prem.endOf(uid) > paidEnd);
  const r = await prem.adminRevoke({ userId: uid });
  assert.ok(r.ok && r.revoked === 1);
  assert.equal(prem.endOf(uid), paidEnd);
});
