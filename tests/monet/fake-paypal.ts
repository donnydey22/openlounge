// Fake PayPal for monetization tests: Orders v2 (create/get/capture with PayPal-Request-Id idempotency),
// Subscriptions (create/get/cancel), OAuth and webhook signature verification. No network.
import type { FetchLike } from "../../server/stickers/paypal";

export type Call = { url: string; method: string; headers: Record<string, string>; body: any };

export function fakePayPal() {
  const calls: Call[] = [];
  const orders = new Map<string, any>();
  const subs = new Map<string, any>();
  const idem = new Map<string, any>();
  let n = 0;
  let verify = "SUCCESS";
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
      const o = { id: `ORDER${++n}TEST`, status: "CREATED", purchase_units: body.purchase_units, request: body };
      orders.set(o.id, o);
      if (rid) idem.set(rid, o);
      return res(201, o);
    }
    const m = p.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (m) {
      const o = orders.get(m[1]);
      if (!o) return res(404, { name: "RESOURCE_NOT_FOUND" });
      if (!m[2]) return res(200, o);
      if (o.status === "COMPLETED") return res(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      o.status = "COMPLETED";
      o.payer = { email_address: "buyer@example.com" };
      o.payment_source = { paypal: {} };
      o.purchase_units[0].payments = { captures: [{ id: `CAP-${o.id}`, status: "COMPLETED", amount: o.purchase_units[0].amount }] };
      if (rid) idem.set(rid, o);
      return res(201, o);
    }
    if (p === "/v1/billing/subscriptions" && c.method === "POST") {
      const s = { id: `I-SUB${++n}`, status: "APPROVAL_PENDING", plan_id: body.plan_id, custom_id: body.custom_id, request: body, links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${n}` }] };
      subs.set(s.id, s);
      if (rid) idem.set(rid, s);
      return res(201, s);
    }
    const sm = p.match(/^\/v1\/billing\/subscriptions\/([^/]+)(\/cancel)?$/);
    if (sm) {
      const s = subs.get(sm[1]);
      if (!s) return res(404, { name: "RESOURCE_NOT_FOUND" });
      if (sm[2]) {
        s.status = "CANCELLED";
        return { ok: true, status: 204, json: async () => { throw new Error("no body"); }, text: async () => "" };
      }
      return res(200, s);
    }
    return res(404, {});
  };
  return { fetchFn, calls, orders, subs, setVerify: (v: string) => (verify = v) };
}

export const hook = (id: string, type: string, resource: unknown) =>
  [
    { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "t-" + id, "paypal-transmission-sig": "sig", "paypal-transmission-time": new Date().toISOString() },
    JSON.stringify({ id, event_type: type, resource }),
  ] as const;

export const PAID_ENV = { STICKERS_PAID_ENABLED: "1", PAYPAL_CLIENT_ID: "cid", PAYPAL_CLIENT_SECRET: "sec", PAYPAL_MODE: "sandbox", PAYPAL_WEBHOOK_ID: "WH-1" };
