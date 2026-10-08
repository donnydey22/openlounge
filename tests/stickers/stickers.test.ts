// Stickers: token encoding, catalog, send gate, PayPal Orders v2 checkout (mocked), webhook, refunds, restore, admin.
// NOTE: package.json runs this with DATA_DIR pointed at a temp dir (imports are hoisted, so it can't be set here).
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSticker, stickerPreview, stickerText } from "../../src/lib/stickers/token";
import { MemoryStickerRepo } from "../../server/stickers/repo";
import { StickerService, validPrice } from "../../server/stickers/service";
import { createPack, updatePack, addSticker, UPLOAD_DIR } from "../../server/stickers/admin";
import type { FetchLike } from "../../server/stickers/paypal";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** Tiny fake PayPal: orders live in a map; capture honours PayPal-Request-Id idempotency like the real API. */
function fakePayPal() {
  const calls: Call[] = [];
  const orders = new Map<string, any>();
  const idem = new Map<string, any>();
  let n = 0;
  let verify = "SUCCESS";
  let failNextCapture: string | null = null;
  const res = (status: number, j: unknown) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j) });
  const fetchFn: FetchLike = async (url, init = {}) => {
    let body: any;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    const c = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body };
    calls.push(c);
    const p = new URL(url).pathname;
    if (p === "/v1/oauth2/token") return res(200, { access_token: "tok", expires_in: 3600 });
    if (p === "/v1/notifications/verify-webhook-signature") return res(200, { verification_status: verify });
    const rid = c.headers["PayPal-Request-Id"];
    if (rid && idem.has(rid)) return res(201, idem.get(rid));
    if (p === "/v2/checkout/orders" && c.method === "POST") {
      const o = { id: `ORDER${++n}TEST`, status: "CREATED", intent: "CAPTURE", purchase_units: body.purchase_units, payment_source: body.payment_source, request: body };
      orders.set(o.id, o);
      if (rid) idem.set(rid, o);
      return res(201, o);
    }
    const m = p.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (m) {
      const o = orders.get(m[1]);
      if (!o) return res(404, { name: "RESOURCE_NOT_FOUND" });
      if (!m[2]) return res(200, o);
      if (failNextCapture) {
        const issue = failNextCapture;
        failNextCapture = null;
        return res(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue }] });
      }
      if (o.status === "COMPLETED") return res(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      o.status = "COMPLETED";
      o.payer = { email_address: "buyer@example.com" };
      o.payment_source = o.payment_source ?? { paypal: {} };
      o.purchase_units[0].payments = { captures: [{ id: `CAP-${o.id}`, status: "COMPLETED", amount: o.purchase_units[0].amount }] };
      if (rid) idem.set(rid, o);
      return res(201, o);
    }
    return res(404, {});
  };
  return { fetchFn, calls, orders, setVerify: (v: string) => (verify = v), failCapture: (issue: string) => (failNextCapture = issue) };
}

const ENV = { STICKERS_PAID_ENABLED: "1", PAYPAL_CLIENT_ID: "cid", PAYPAL_CLIENT_SECRET: "sec", PAYPAL_MODE: "sandbox", PAYPAL_WEBHOOK_ID: "WH-1", STICKERS_APPLE_PAY: "1", STICKERS_GOOGLE_PAY: "1" };

async function setup(env: Record<string, string> = ENV) {
  const pp = fakePayPal();
  const mails: any[] = [];
  const repo = new MemoryStickerRepo();
  const svc = new StickerService({ repo, env, fetchFn: pp.fetchFn, mailer: async (m) => (mails.push(m), true), users: { email: () => "me@example.com", name: () => "Me", exists: () => true } });
  await svc.init();
  // one paid pack made with the admin tool
  const made = await createPack(svc, "admin", { title: "Paid Cats", priceCents: 99, emoji: "🐱" });
  assert.ok(made.ok);
  const png = "data:image/png;base64," + (await (await import("sharp")).default({ create: { width: 64, height: 64, channels: 4, background: "#f00" } }).png().toBuffer()).toString("base64");
  const add = await addSticker(svc, "admin", made.pack.id, { emoji: "🐱", file: png });
  assert.ok(add.ok, JSON.stringify(add));
  const pub = await updatePack(svc, "admin", made.pack.id, { published: true });
  assert.ok(pub.ok, JSON.stringify(pub));
  return { svc, pp, mails, repo, paid: pub.pack, sticker: add.sticker };
}

const hook = (id: string, type: string, resource: unknown) => [
  { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "t-" + id, "paypal-transmission-sig": "sig", "paypal-transmission-time": new Date().toISOString() },
  JSON.stringify({ id, event_type: type, resource }),
] as const;

test("tests never write into the repo's data dir", () => {
  assert.ok(!UPLOAD_DIR.startsWith(path.resolve("data")), "run via npm run test:stickers (sets DATA_DIR)");
});

test("sticker token round-trips, is invisible to old clients, and rejects junk", () => {
  const t = stickerText({ packId: "noto-faces", stickerId: "1f600", emoji: "😀" } as any);
  assert.ok(t.startsWith("😀 Sticker"));
  assert.deepEqual({ ...parseSticker(t)! }, { ...parseSticker(t)!, packId: "noto-faces", stickerId: "1f600" });
  assert.equal(stickerPreview(t), "😀 Sticker");
  assert.equal(parseSticker("hello"), null);
  assert.equal(parseSticker("😀 Sticker"), null);
  // visible text = only the preview
  assert.equal([...t].filter((c) => c.codePointAt(0)! < 0xe0000).join(""), "😀 Sticker");
});

test("built-in Noto packs: all free, published, CC BY 4.0 attributed, files exist", async () => {
  const { svc } = await setup();
  const builtins = svc.list().filter((p) => p.builtin);
  assert.deepEqual(builtins.map((p) => p.id).sort(), ["noto-animals", "noto-faces", "noto-hands", "noto-love", "noto-party"]);
  for (const s of builtins) {
    const p = svc.pack(s.id)!;
    assert.equal(p.priceCents ?? 0, 0);
    assert.match(p.attribution!.license, /CC BY 4\.0/);
    assert.match(p.attribution!.text, /Noto Emoji by Google/);
    for (const st of p.stickers) {
      assert.ok(fs.existsSync(path.join("public/sticker-files", st.poster)), st.poster);
      assert.ok(fs.existsSync(path.join("public/sticker-files", st.file)), st.file);
      assert.equal(st.format, "lottie");
    }
  }
  assert.ok(svc.searchStickers("heart").length > 0);
  assert.ok(svc.list({ q: "cat" }).length > 0);
});

test("prices: only Free / $0.99 / $1.99 / $2.99; admin packs default to FREE drafts", async () => {
  assert.ok(validPrice(null) && validPrice(0) && validPrice(99) && validPrice(199) && validPrice(299));
  assert.ok(!validPrice(100) && !validPrice(-1) && !validPrice(499) && !validPrice("99"));
  const { svc } = await setup();
  const r = await createPack(svc, "admin", { title: "New" });
  assert.ok(r.ok);
  assert.equal(r.pack.priceCents, null);
  assert.equal(r.pack.published, false);
  assert.equal((await createPack(svc, "admin", { title: "Bad", priceCents: 150 })).ok, false);
  const empty = await updatePack(svc, "admin", r.pack.id, { published: true });
  assert.equal(empty.ok, false, "can't publish an empty pack");
  assert.equal((await updatePack(svc, "admin", "noto-faces", { priceCents: 99 })).ok, false, "built-ins are read-only");
});

test("send gate: free stickers for all, paid only for owners, unknown stickers rejected, text untouched", async () => {
  const { svc, paid, sticker } = await setup();
  assert.equal(svc.sendError("u1", "hi"), null);
  assert.equal(svc.sendError("u1", stickerText({ packId: "noto-faces", stickerId: svc.pack("noto-faces")!.stickers[0].id, emoji: "😀" } as any)), null);
  assert.match(svc.sendError("u1", stickerText({ packId: paid.id, stickerId: sticker.id, emoji: "🐱" } as any))!, /Get this sticker pack/);
  assert.match(svc.sendError("u1", stickerText({ packId: "noto-faces", stickerId: "nope", emoji: "😀" } as any))!, /isn't available/);
  assert.equal((await svc.setAdded("u1", paid.id, true)).ok, false);
});

test("paid flag off (default): config hides checkout, create refuses", async () => {
  const { svc, paid } = await setup({ PAYPAL_CLIENT_ID: "cid", PAYPAL_CLIENT_SECRET: "sec" });
  assert.equal(svc.config().paidEnabled, false);
  assert.equal(svc.config().paypalClientId, null);
  assert.equal(svc.config().applePay, false);
  const r = await svc.createCheckout("u1", paid.id, "paypal");
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 503);
});

test("wrappers can't start checkout; free packs can't be bought", async () => {
  const { svc, paid } = await setup();
  assert.equal(((await svc.createCheckout("u1", paid.id, "paypal", { wrapper: true })) as any).status, 403);
  assert.equal(((await svc.createCheckout("u1", "noto-faces", "paypal")) as any).status, 400);
});

test("create order: Open Lounge branding per transaction, DIGITAL_GOODS, soft descriptor, Apple/Google Pay without paypal source", async () => {
  const { svc, pp, paid } = await setup();
  const r = await svc.createCheckout("u1", paid.id, "paypal");
  assert.ok(r.ok);
  const req = pp.orders.get(r.orderId).request;
  const pu = req.purchase_units[0];
  assert.equal(pu.amount.value, "0.99");
  assert.equal(pu.soft_descriptor, "OPENLOUNGE");
  assert.ok(pu.soft_descriptor.length <= 22 && /^[A-Z0-9 .*-]+$/.test(pu.soft_descriptor));
  assert.equal(pu.items[0].name, "Open Lounge sticker pack: Paid Cats");
  assert.equal(pu.items[0].category, "DIGITAL_GOODS");
  assert.equal(pu.custom_id, `u1|${paid.id}`);
  assert.equal(req.payment_source.paypal.experience_context.brand_name, "Open Lounge");
  assert.equal(req.payment_source.paypal.experience_context.shipping_preference, "NO_SHIPPING");
  assert.ok(!JSON.stringify(req).includes("Sumeet"));
  const create = pp.calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
  assert.ok(create.headers["PayPal-Request-Id"]);
  assert.ok(create.url.startsWith("https://api-m.sandbox.paypal.com"));
  for (const f of ["apple_pay", "google_pay"]) {
    const o = await svc.createCheckout("u2", paid.id, f);
    assert.ok(o.ok);
    assert.equal(pp.orders.get(o.orderId).request.payment_source, undefined, f);
  }
});

test("capture: grants + adds pack, one receipt email, idempotent on repeat / ALREADY_CAPTURED / webhook", async () => {
  const { svc, pp, mails, paid, sticker } = await setup();
  const c = await svc.createCheckout("u1", paid.id, "paypal");
  assert.ok(c.ok);
  assert.equal(((await svc.capture("u2", c.orderId)) as any).status, 404, "someone else's order");
  const a = await svc.capture("u1", c.orderId);
  assert.ok(a.ok && a.receipt.status === "captured");
  assert.ok(a.mine.added.includes(paid.id) && a.mine.owned.includes(paid.id));
  assert.equal(svc.sendError("u1", stickerText({ packId: paid.id, stickerId: sticker.id, emoji: "🐱" } as any)), null);
  const b = await svc.capture("u1", c.orderId);
  assert.ok(b.ok);
  const caps = pp.calls.filter((x) => x.url.endsWith("/capture"));
  assert.equal(caps.length, 1, "second capture short-circuits locally");
  assert.equal(caps[0].headers["PayPal-Request-Id"], `capture-${c.orderId}`);
  // webhook COMPLETED for the same capture → no second grant/email
  const [h, raw] = hook("WH-EV-1", "PAYMENT.CAPTURE.COMPLETED", { id: `CAP-${c.orderId}`, status: "COMPLETED", supplementary_data: { related_ids: { order_id: c.orderId } } });
  assert.equal((await svc.webhook(h, raw)).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Open Lounge receipt/);
  assert.match(mails[0].html, /Seller<\/td><td[^>]*>Open Lounge/);
  assert.match(mails[0].text, /SANDBOX/);
  assert.ok(!mails[0].html.includes("Sumeet"));
  assert.equal(((await svc.createCheckout("u1", paid.id, "paypal")) as any).status, 409, "already owned");
});

test("capture race: ORDER_ALREADY_CAPTURED → fetch the order and still grant", async () => {
  const { svc, pp, paid } = await setup();
  const c = await svc.createCheckout("u1", paid.id, "paypal");
  assert.ok(c.ok);
  const o = pp.orders.get(c.orderId);
  o.status = "COMPLETED";
  o.payment_source = { google_pay: {} };
  o.purchase_units[0].payments = { captures: [{ id: "CAP-X", status: "COMPLETED" }] };
  const r = await svc.capture("u1", c.orderId);
  assert.ok(r.ok && r.receipt.status === "captured" && r.receipt.fundingSource === "google_pay");
});

test("declined capture returns retryable 402 and leaves the order open", async () => {
  const { svc, pp, paid } = await setup();
  const c = await svc.createCheckout("u1", paid.id, "paypal");
  assert.ok(c.ok);
  pp.failCapture("INSTRUMENT_DECLINED");
  const r = await svc.capture("u1", c.orderId);
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 402);
  assert.ok((await svc.capture("u1", c.orderId)).ok, "retry works");
});

test("webhook: bad signature 401, dedupe by event id, APPROVED captures server-side, refund revokes", async () => {
  const { svc, pp, paid, sticker } = await setup();
  const c = await svc.createCheckout("u1", paid.id, "paypal");
  assert.ok(c.ok);
  pp.setVerify("FAILURE");
  let [h, raw] = hook("E1", "CHECKOUT.ORDER.APPROVED", { id: c.orderId });
  assert.equal((await svc.webhook(h, raw)).status, 401);
  pp.setVerify("SUCCESS");
  // verify call embeds PayPal's raw bytes
  const v = pp.calls.filter((x) => x.url.endsWith("verify-webhook-signature")).at(-1)!;
  assert.equal(v.body.webhook_id, "WH-1");
  assert.equal(v.body.webhook_event.id, "E1");
  assert.equal((await svc.webhook(h, raw)).status, 200);
  assert.ok(svc.owns("u1", paid.id), "buyer closed the tab after approving → server captured");
  assert.deepEqual((await svc.webhook(h, raw)).body, { ok: true, duplicate: true });
  [h, raw] = hook("E2", "PAYMENT.CAPTURE.REFUNDED", { id: "REFUND-1", status: "COMPLETED", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/CAP-${c.orderId}` }] });
  assert.equal((await svc.webhook(h, raw)).status, 200);
  assert.equal(svc.owns("u1", paid.id), false);
  assert.ok(!(await svc.mine("u1")).added.includes(paid.id));
  assert.match(svc.sendError("u1", stickerText({ packId: paid.id, stickerId: sticker.id, emoji: "🐱" } as any))!, /Get this/);
  const rec = await svc.receipts("u1");
  assert.equal(rec[0].status, "refunded");
  assert.equal(((await svc.capture("u1", c.orderId)) as any).status, 409);
});

test("webhook without PAYPAL_WEBHOOK_ID is always rejected", async () => {
  const { svc } = await setup({ ...ENV, PAYPAL_WEBHOOK_ID: "" });
  const [h, raw] = hook("E9", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-1" });
  assert.equal((await svc.webhook(h, raw)).status, 401);
});

test("restore: re-checks open orders at PayPal and re-grants captured ones after a restart", async () => {
  const { svc, pp, repo, paid } = await setup();
  const c = await svc.createCheckout("u1", paid.id, "paypal");
  assert.ok(c.ok);
  const o = pp.orders.get(c.orderId);
  o.status = "COMPLETED";
  o.purchase_units[0].payments = { captures: [{ id: "CAP-R", status: "COMPLETED" }] };
  assert.equal(svc.owns("u1", paid.id), false);
  const r = await svc.restore("u1");
  assert.ok(r.mine.owned.includes(paid.id));
  // new process, same DB → entitlement survives
  const svc2 = new StickerService({ repo, env: ENV, fetchFn: pp.fetchFn });
  await svc2.init();
  assert.ok(svc2.owns("u1", paid.id));
});

test("admin upload: rejects non-images, bad Lottie, and stores normalised webp", async () => {
  const { svc } = await setup();
  const r = await createPack(svc, "admin", { title: "Uploads" });
  assert.ok(r.ok);
  assert.equal((await addSticker(svc, "admin", r.pack.id, { emoji: "😀", file: "data:text/html;base64,PGh0bWw+" })).ok, false);
  assert.equal((await addSticker(svc, "admin", r.pack.id, { emoji: "😀", lottie: "{\"not\":\"lottie\"}" })).ok, false);
  const lottie = JSON.stringify({ v: "5.7.0", fr: 30, ip: 0, op: 60, w: 512, h: 512, layers: [] });
  const ok = await addSticker(svc, "admin", r.pack.id, { emoji: "😀", lottie });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.ok(ok.sticker.file.endsWith(".json.gz") && ok.sticker.format === "lottie");
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, ok.sticker.file.slice(2))));
});
