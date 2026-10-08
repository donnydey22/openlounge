// Sticker library service: catalog (built-in Noto packs + admin packs), My stickers / favorites / recents,
// paid-pack entitlements, PayPal checkout (create / idempotent capture / webhook / restore / refunds) and receipts.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MemoryStickerRepo, PgStickerRepo, type OrderRow, type StickerRepo } from "./repo";
import { PayPalClient, PayPalError, captureOf, fundingOf, paypalConfigFromEnv, type FetchLike, type PayPalOrder } from "./paypal";
import { PRICE_TIERS, formatPrice, isFree, type MyStickers, type PackSummary, type Receipt, type StickerConfig, type StickerPack } from "../../src/lib/stickers/types";
import { STICKER_ID_RE, parseSticker } from "../../src/lib/stickers/token";

const BRAND = "Open Lounge";
const SITE = process.env.AUTH_PUBLIC_URL?.replace(/\/$/, "") || "https://openlounge.app";

function loadBuiltin(): StickerPack[] {
  const candidates = [path.join(process.cwd(), "server/stickers/noto-packs.json"), typeof __dirname !== "undefined" ? path.join(__dirname, "noto-packs.json") : ""];
  for (const f of candidates)
    if (f && fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, "utf8")) as { packs: StickerPack[] };
      return j.packs;
    }
  console.warn("[stickers] noto-packs.json not found; no built-in packs");
  return [];
}

export const validPrice = (v: unknown): v is number | null => v === null || v === 0 || (typeof v === "number" && (PRICE_TIERS as readonly number[]).includes(v));

export interface Mailer {
  (mail: { to: string; subject: string; text: string; html: string }): Promise<boolean>;
}
export interface UserLookup {
  email(userId: string): string | null;
  name(userId: string): string;
  exists(userId: string): boolean;
}

/**
 * Non-sticker products sold through the same PayPal checkout / webhook / receipt / restore pipeline
 * (Premium, paid verification, …). Orders store the product ref in sticker_orders.pack_id as "<prefix>:<rest>".
 * Handlers must be idempotent per order id (restore + webhooks may call fulfil more than once).
 */
export interface ProductHandler {
  /** price + labels for a checkout; null = not purchasable by this user right now (error says why) */
  quote(userId: string, ref: string): { ok: true; amountCents: number; currency: string; title: string } | { ok: false; status: number; error: string };
  /** receipt label, e.g. "Open Lounge Premium (1 month)" */
  title(ref: string): string;
  fulfil(order: OrderRow): Promise<void>;
  revoke(order: OrderRow): Promise<void>;
  /** optional extra webhook events (e.g. BILLING.SUBSCRIPTION.*) — return true if handled */
  webhook?(event: { id?: string; event_type?: string; resource?: Record<string, unknown> }): Promise<boolean>;
  /** where receipts send people ("Manage" link) */
  manageUrl?: string;
}
export const productPrefix = (ref: string) => (ref.includes(":") ? ref.split(":")[0] : null);

export interface ServiceOptions {
  repo?: StickerRepo;
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  mailer?: Mailer;
  users?: UserLookup;
}

export class StickerService {
  repo!: StickerRepo;
  private packs = new Map<string, StickerPack>();
  private ents = new Map<string, Set<string>>(); // userId -> owned paid packIds
  paypal: PayPalClient | null = null;
  private env: Record<string, string | undefined>;
  mailer: Mailer | null;
  users: UserLookup | null;
  ready = false;
  private products = new Map<string, ProductHandler>();
  /** premium perk: members own every premium-exclusive pack (set by server/premium) */
  isPremium: (userId: string) => boolean = () => false;
  /** Premium exclusive packs are only listed while Premium is switched on (PREMIUM_ENABLED) */
  premiumVisible: () => boolean = () => false;

  registerProduct(prefix: string, h: ProductHandler) {
    this.products.set(prefix, h);
  }
  productOf(ref: string) {
    const pre = productPrefix(ref);
    return pre ? (this.products.get(pre) ?? null) : null;
  }

  constructor(private opts: ServiceOptions = {}) {
    this.env = opts.env ?? process.env;
    this.mailer = opts.mailer ?? null;
    this.users = opts.users ?? null;
  }

  async init() {
    this.repo = this.opts.repo ?? (this.env.DATABASE_URL ? new PgStickerRepo(this.env.DATABASE_URL) : new MemoryStickerRepo());
    const cfg = paypalConfigFromEnv(this.env);
    this.paypal = cfg ? new PayPalClient(cfg, this.opts.fetchFn) : null;
    for (const p of loadBuiltin()) this.packs.set(p.id, p);
    await this.reload();
    this.ready = true;
  }

  async reload() {
    for (const p of await this.repo.listPacks()) if (!this.packs.get(p.id)?.builtin) this.packs.set(p.id, p);
    this.ents.clear();
    for (const e of await this.repo.allEntitlements()) this.own(e.userId, e.packId, true);
  }

  private own(userId: string, packId: string, yes: boolean) {
    const s = this.ents.get(userId) ?? new Set<string>();
    if (yes) s.add(packId);
    else s.delete(packId);
    this.ents.set(userId, s);
  }

  // ---------- config / flags ----------

  /** Paid checkout needs BOTH the flag and credentials. Off by default (Donny: ship free first). */
  get paidEnabled() {
    return /^(1|true|yes)$/i.test(this.env.STICKERS_PAID_ENABLED ?? "") && !!this.paypal;
  }

  config(): StickerConfig {
    const on = this.paidEnabled;
    return {
      paidEnabled: on,
      mode: this.paypal?.cfg.mode ?? "sandbox",
      paypalClientId: on ? this.paypal!.cfg.clientId : null,
      applePay: on && /^(1|true|yes)$/i.test(this.env.STICKERS_APPLE_PAY ?? ""),
      googlePay: on && /^(1|true|yes)$/i.test(this.env.STICKERS_GOOGLE_PAY ?? ""),
      googleMerchantId: on ? this.env.GOOGLE_PAY_MERCHANT_ID || null : null,
      currency: "USD",
      tiers: PRICE_TIERS,
    };
  }

  // ---------- catalog ----------

  pack(id: string, opts: { includeDrafts?: boolean } = {}) {
    const p = this.packs.get(id);
    if (!p || (!p.published && !opts.includeDrafts)) return null;
    if (p.premium && !opts.includeDrafts && !this.premiumVisible()) return null;
    return p;
  }

  summary(p: StickerPack): PackSummary {
    const { stickers, ...rest } = p;
    return { ...rest, count: stickers.length, preview: stickers.slice(0, 5) };
  }

  list(opts: { q?: string; category?: string; includeDrafts?: boolean } = {}) {
    const q = (opts.q ?? "").trim().toLowerCase();
    let packs = [...this.packs.values()].filter((p) => opts.includeDrafts || (p.published && (!p.premium || this.premiumVisible())));
    if (opts.category) packs = packs.filter((p) => p.category === opts.category);
    if (q)
      packs = packs.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.stickers.some((s) => s.emoji === q || s.keywords.some((k) => k.includes(q))),
      );
    // built-ins first, then newest admin packs
    return packs.map((p) => this.summary(p));
  }

  categories() {
    return [...new Set([...this.packs.values()].filter((p) => p.published).map((p) => p.category))];
  }

  /** Sticker search across packs (emoji or keyword), for the panel's search box. */
  searchStickers(q: string, limit = 60) {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    const out: { packId: string; sticker: StickerPack["stickers"][number] }[] = [];
    for (const p of this.packs.values()) {
      if (!p.published || (p.premium && !this.premiumVisible())) continue;
      for (const s of p.stickers) if (s.emoji === q.trim() || s.keywords.some((k) => k.includes(n))) out.push({ packId: p.id, sticker: s });
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  owns(userId: string, packId: string) {
    const p = this.packs.get(packId);
    if (!p) return false;
    if (p.premium) return this.isPremium(userId);
    return isFree(p) || !!this.ents.get(userId)?.has(packId);
  }

  ownedPaid(userId: string) {
    return [...(this.ents.get(userId) ?? [])];
  }

  /**
   * Gate for sending a sticker message (dm:send / chat:send): null = allowed, else a user-facing reason.
   * Ordinary text is always allowed. Free packs: anyone. Paid packs: the buyer only (receivers can always SEE them).
   */
  sendError(userId: string, text: unknown): string | null {
    if (typeof text !== "string" || !this.ready) return null;
    const ref = parseSticker(text);
    if (!ref) return null;
    const p = this.packs.get(ref.packId);
    if (!p || !p.stickers.some((s) => s.id === ref.stickerId)) return "That sticker isn't available.";
    if (p.premium && !this.isPremium(userId)) return "This sticker pack is for Open Lounge Premium members.";
    if (!p.premium && !isFree(p) && !this.ents.get(userId)?.has(p.id)) return "Get this sticker pack to send it.";
    return null;
  }

  // ---------- My stickers ----------

  async mine(userId: string): Promise<MyStickers> {
    const m = await this.repo.mine(userId);
    const live = (r: { packId: string; stickerId: string }) => !!this.packs.get(r.packId)?.stickers.some((s) => s.id === r.stickerId);
    return {
      added: m.added.filter((id) => this.packs.get(id)?.published && this.owns(userId, id)),
      favorites: m.favorites.filter(live),
      recents: m.recents.filter(live),
      owned: [...this.ownedPaid(userId), ...(this.isPremium(userId) ? [...this.packs.values()].filter((p) => p.premium && p.published).map((p) => p.id) : [])],
    };
  }

  async setAdded(userId: string, packId: string, add: boolean) {
    const p = this.pack(packId);
    if (add && !p) return { ok: false as const, status: 404, error: "Sticker pack not found" };
    if (add && !this.owns(userId, packId)) return { ok: false as const, status: 402, error: "Get this pack first" };
    await this.repo.setAdded(userId, packId, add);
    return { ok: true as const, mine: await this.mine(userId) };
  }

  async reorder(userId: string, packIds: unknown) {
    if (!Array.isArray(packIds) || packIds.length > 200 || !packIds.every((x) => typeof x === "string" && STICKER_ID_RE.test(x))) return { ok: false as const, status: 400, error: "packIds required" };
    await this.repo.reorder(userId, packIds as string[]);
    return { ok: true as const, mine: await this.mine(userId) };
  }

  private validRef(packId: unknown, stickerId: unknown) {
    if (typeof packId !== "string" || typeof stickerId !== "string") return null;
    const p = this.packs.get(packId);
    return p && p.stickers.some((s) => s.id === stickerId) ? { packId, stickerId } : null;
  }

  async setFavorite(userId: string, packId: unknown, stickerId: unknown, fav: boolean) {
    const ref = this.validRef(packId, stickerId);
    if (!ref) return { ok: false as const, status: 404, error: "Sticker not found" };
    await this.repo.setFavorite(userId, ref, fav);
    return { ok: true as const, mine: await this.mine(userId) };
  }

  async used(userId: string, packId: unknown, stickerId: unknown) {
    const ref = this.validRef(packId, stickerId);
    if (!ref) return { ok: false as const, status: 404, error: "Sticker not found" };
    await this.repo.addRecent(userId, ref);
    return { ok: true as const };
  }

  // ---------- checkout ----------

  private receipt(o: OrderRow): Receipt {
    return {
      orderId: o.id,
      packId: o.packId,
      packTitle: this.productOf(o.packId)?.title(o.packId) ?? this.packs.get(o.packId)?.title ?? o.packId,
      amountCents: o.amountCents,
      currency: o.currency,
      status: o.status,
      fundingSource: o.fundingSource,
      createdAt: o.createdAt,
      capturedAt: o.capturedAt,
      refundedAt: o.refundedAt,
      mode: o.mode,
    };
  }

  async createCheckout(userId: string, packId: unknown, funding: unknown, opts: { wrapper?: boolean } = {}) {
    if (!this.paidEnabled || !this.paypal) return { ok: false as const, status: 503, error: "Paid stickers aren't available yet" };
    // Phone wrappers never start a purchase in-app (App Store 3.1.1 / Play Payments policy); see STORE_RULES.md.
    if (opts.wrapper) return { ok: false as const, status: 403, error: "Purchases happen on openlounge.app" };
    if (typeof packId === "string" && this.productOf(packId)) return this.createProductCheckout(userId, packId, funding);
    const p = typeof packId === "string" ? this.pack(packId) : null;
    if (!p) return { ok: false as const, status: 404, error: "Sticker pack not found" };
    if (p.premium) return { ok: false as const, status: 400, error: "This pack comes with Open Lounge Premium" };
    if (isFree(p)) return { ok: false as const, status: 400, error: "This pack is free" };
    if (this.owns(userId, p.id)) return { ok: false as const, status: 409, error: "You already own this pack" };
    const f = typeof funding === "string" && ["paypal", "apple_pay", "google_pay"].includes(funding) ? funding : "paypal";
    const requestId = `create-${userId}-${p.id}-${randomBytes(6).toString("hex")}`;
    let order: PayPalOrder;
    try {
      order = await this.paypal.createOrder({ requestId, funding: f, amountCents: p.priceCents!, currency: p.currency, packId: p.id, userId, title: p.title, brand: BRAND });
    } catch (err) {
      console.error("[stickers] create order failed", (err as Error).message);
      return { ok: false as const, status: 502, error: "Couldn't start checkout. Please try again." };
    }
    await this.repo.createOrder({
      id: order.id,
      userId,
      packId: p.id,
      amountCents: p.priceCents!,
      currency: p.currency,
      status: "created",
      captureId: null,
      fundingSource: f,
      payerEmail: null,
      mode: this.paypal.cfg.mode,
      createdAt: Date.now(),
      capturedAt: null,
      refundedAt: null,
      receiptSentAt: null,
    });
    return { ok: true as const, orderId: order.id };
  }

  private async createProductCheckout(userId: string, ref: string, funding: unknown) {
    const h = this.productOf(ref)!;
    const q = h.quote(userId, ref);
    if (!q.ok) return q;
    const f = typeof funding === "string" && ["paypal", "apple_pay", "google_pay"].includes(funding) ? funding : "paypal";
    const requestId = `create-${userId}-${ref.replace(/[^\w-]/g, "_")}-${randomBytes(6).toString("hex")}`;
    let order: PayPalOrder;
    try {
      order = await this.paypal!.createOrder({ requestId, funding: f, amountCents: q.amountCents, currency: q.currency, packId: ref, userId, title: q.title, itemName: q.title, brand: BRAND });
    } catch (err) {
      console.error("[billing] create order failed", (err as Error).message);
      return { ok: false as const, status: 502, error: "Couldn't start checkout. Please try again." };
    }
    await this.repo.createOrder({ id: order.id, userId, packId: ref, amountCents: q.amountCents, currency: q.currency, status: "created", captureId: null, fundingSource: f, payerEmail: null, mode: this.paypal!.cfg.mode, createdAt: Date.now(), capturedAt: null, refundedAt: null, receiptSentAt: null });
    return { ok: true as const, orderId: order.id };
  }

  /** Mark an order paid (idempotent: only the first caller flips created→captured, grants and emails). */
  private async completeOrder(order: OrderRow, pp: PayPalOrder | null, captureId: string) {
    const funding = (pp && fundingOf(pp)) || order.fundingSource;
    const payerEmail = pp?.payer?.email_address ?? null;
    const flipped = await this.repo.transition(order.id, ["created", "failed"], { status: "captured", captureId, capturedAt: Date.now(), fundingSource: funding, payerEmail });
    const row = flipped ?? (await this.repo.getOrder(order.id))!;
    if (row.status === "captured" && this.productOf(row.packId)) {
      await this.productOf(row.packId)!.fulfil(row);
      if (flipped) void this.sendReceipt(row);
    } else if (row.status === "captured") {
      await this.repo.grant(row.userId, row.packId, row.id);
      this.own(row.userId, row.packId, true);
      await this.repo.setAdded(row.userId, row.packId, true);
      if (flipped) void this.sendReceipt(row);
    }
    return row;
  }

  async capture(userId: string, orderId: unknown) {
    if (!this.paypal) return { ok: false as const, status: 503, error: "Paid stickers aren't available yet" };
    if (typeof orderId !== "string" || !/^[A-Z0-9-]{5,64}$/i.test(orderId)) return { ok: false as const, status: 400, error: "orderId required" };
    const order = await this.repo.getOrder(orderId);
    if (!order || order.userId !== userId) return { ok: false as const, status: 404, error: "Order not found" };
    if (order.status === "captured") return { ok: true as const, receipt: this.receipt(order), mine: await this.mine(userId) };
    if (order.status === "refunded" || order.status === "reversed") return { ok: false as const, status: 409, error: "This order was refunded" };
    let pp: PayPalOrder;
    try {
      pp = await this.paypal.captureOrder(orderId);
    } catch (err) {
      if (err instanceof PayPalError && err.issue === "ORDER_ALREADY_CAPTURED") pp = await this.paypal.getOrder(orderId);
      else if (err instanceof PayPalError && err.issue === "INSTRUMENT_DECLINED") return { ok: false as const, status: 402, error: "Payment was declined. Try another payment method.", retry: true };
      else {
        console.error("[stickers] capture failed", (err as Error).message);
        return { ok: false as const, status: 502, error: "Payment didn't go through. You weren't charged." };
      }
    }
    const cap = captureOf(pp);
    if (pp.status === "COMPLETED" && cap?.status === "COMPLETED") {
      const row = await this.completeOrder(order, pp, cap.id);
      return { ok: true as const, receipt: this.receipt(row), mine: await this.mine(userId) };
    }
    if (cap?.status === "PENDING") {
      if (cap.id) await this.repo.update(order.id, { captureId: cap.id });
      return { ok: true as const, pending: true, receipt: this.receipt({ ...order }), mine: await this.mine(userId) };
    }
    await this.repo.transition(order.id, ["created"], { status: "failed" });
    return { ok: false as const, status: 402, error: "Payment didn't go through. You weren't charged." };
  }

  /** Re-check PayPal for orders that never finished on this device, and re-grant anything paid. */
  async restore(userId: string) {
    const orders = await this.repo.ordersOf(userId);
    for (const o of orders) {
      if (o.status === "captured" && this.productOf(o.packId)) {
        await this.productOf(o.packId)!.fulfil(o);
        continue;
      }
      if (o.status === "captured") {
        if (!this.ents.get(userId)?.has(o.packId)) {
          await this.repo.grant(userId, o.packId, o.id);
          this.own(userId, o.packId, true);
        }
        continue;
      }
      if (o.status === "created" && this.paypal && o.mode === this.paypal.cfg.mode) {
        try {
          const pp = await this.paypal.getOrder(o.id);
          const cap = captureOf(pp);
          if (pp.status === "COMPLETED" && cap?.status === "COMPLETED") await this.completeOrder(o, pp, cap.id);
          else if (pp.status === "APPROVED") await this.capture(userId, o.id);
        } catch {
          /* order expired / unknown at PayPal: leave it */
        }
      }
    }
    return { ok: true as const, mine: await this.mine(userId), receipts: (await this.repo.ordersOf(userId)).map((o) => this.receipt(o)) };
  }

  async receipts(userId: string) {
    return (await this.repo.ordersOf(userId)).filter((o) => o.status !== "created" || Date.now() - o.createdAt < 3_600_000).map((o) => this.receipt(o));
  }

  // ---------- webhook ----------

  /**
   * PayPal webhook. Signature verified with PayPal (verify-webhook-signature), deduped by event id, then:
   *  CHECKOUT.ORDER.APPROVED     → capture server-side (buyer closed the tab after approving)
   *  PAYMENT.CAPTURE.COMPLETED   → grant (idempotent)
   *  PAYMENT.CAPTURE.REFUNDED / REVERSED → revoke the entitlement
   *  PAYMENT.CAPTURE.DENIED      → mark failed
   */
  async webhook(headers: Record<string, string | string[] | undefined>, raw: string) {
    if (!this.paypal) return { status: 503, body: { ok: false } };
    let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
    try {
      event = JSON.parse(raw);
    } catch {
      return { status: 400, body: { ok: false } };
    }
    if (!(await this.paypal.verifyWebhook(headers, event, raw))) return { status: 401, body: { ok: false, error: "signature" } };
    if (!event.id || !event.event_type) return { status: 400, body: { ok: false } };
    const res = event.resource ?? {};
    const resourceId = typeof res.id === "string" ? res.id : null;
    if (!(await this.repo.markEvent(event.id, event.event_type, resourceId))) return { status: 200, body: { ok: true, duplicate: true } };
    const orderIdOf = () => ((res.supplementary_data as { related_ids?: { order_id?: string } })?.related_ids?.order_id ?? null) as string | null;
    const captureIdOf = () => {
      const up = (res.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "up" && /\/captures\//.test(l.href));
      return up ? up.href.split("/captures/")[1].split(/[/?]/)[0] : resourceId;
    };
    switch (event.event_type) {
      case "CHECKOUT.ORDER.APPROVED": {
        const o = resourceId ? await this.repo.getOrder(resourceId) : null;
        if (o?.status === "created") await this.capture(o.userId, o.id);
        break;
      }
      case "PAYMENT.CAPTURE.COMPLETED": {
        const oid = orderIdOf();
        const o = oid ? await this.repo.getOrder(oid) : resourceId ? await this.repo.orderByCapture(resourceId) : null;
        if (o && resourceId) await this.completeOrder(o, null, resourceId);
        break;
      }
      case "PAYMENT.CAPTURE.REFUNDED":
      case "PAYMENT.CAPTURE.REVERSED": {
        const cid = event.event_type === "PAYMENT.CAPTURE.REVERSED" ? resourceId : captureIdOf();
        const o = cid ? await this.repo.orderByCapture(cid) : orderIdOf() ? await this.repo.getOrder(orderIdOf()!) : null;
        if (o) {
          const status = event.event_type === "PAYMENT.CAPTURE.REFUNDED" ? "refunded" : "reversed";
          await this.repo.transition(o.id, ["captured", "created"], { status, refundedAt: Date.now() });
          const prod = this.productOf(o.packId);
          if (prod) {
            await prod.revoke(o);
            break;
          }
          await this.repo.revoke(o.userId, o.packId, o.id);
          this.own(o.userId, o.packId, false);
          await this.repo.setAdded(o.userId, o.packId, false);
        }
        break;
      }
      default: {
        for (const h of this.products.values()) if (h.webhook && (await h.webhook(event))) break;
        break;
      }
      case "PAYMENT.CAPTURE.DENIED": {
        const oid = orderIdOf();
        if (oid) await this.repo.transition(oid, ["created"], { status: "failed" });
        break;
      }
    }
    return { status: 200, body: { ok: true } };
  }

  // ---------- receipts ----------

  private async sendReceipt(o: OrderRow) {
    try {
      if (!this.mailer) return;
      const to = this.users?.email(o.userId) || o.payerEmail;
      if (!to) return;
      // only the single caller that flipped created→captured gets here, so this sends exactly once
      const p = this.packs.get(o.packId);
      const prod = this.productOf(o.packId);
      const itemLabel = prod ? prod.title(o.packId) : `Open Lounge sticker pack: ${p?.title ?? o.packId}`;
      const manage = prod?.manageUrl ? `${SITE}${prod.manageUrl}` : `${SITE}/stickers/receipts`;
      const price = formatPrice(o.amountCents, o.currency);
      const when = new Date(o.capturedAt ?? Date.now()).toUTCString();
      const via = o.fundingSource === "apple_pay" ? "Apple Pay (via PayPal)" : o.fundingSource === "google_pay" ? "Google Pay (via PayPal)" : "PayPal";
      const sandbox = o.mode === "sandbox" ? " [SANDBOX TEST — no real money moved]" : "";
      const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
      const text = [
        `Open Lounge receipt${sandbox}`,
        ``,
        `Thanks for your purchase from Open Lounge.`,
        ``,
        `Item: ${itemLabel}`,
        `Seller: Open Lounge`,
        `Amount: ${price}`,
        `Paid with: ${via}`,
        `Order: ${o.id}`,
        `Date: ${when}`,
        ``,
        prod ? `Manage it here: ${manage}` : `Your stickers are in My stickers on every device you sign in to. Restore purchases: ${manage}`,
        `Questions or a refund: reply to this email.`,
        ``,
        `Open Lounge · ${SITE}`,
      ].join("\n");
      const row = (k: string, v: string) => `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid #f4f4f5">${k}</td><td style="padding:8px 0;text-align:right;border-bottom:1px solid #f4f4f5">${v}</td></tr>`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Open Lounge receipt</title></head>
<body style="margin:0;padding:0;background:#f4f3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif,'Apple Color Emoji','Noto Color Emoji';color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3ee"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #ebeae4">
<tr><td bgcolor="#0b0b0d" style="background:#0b0b0d;height:64px;padding:0 16px"><a href="${SITE}" style="text-decoration:none;color:#f4f4f5"><span style="font-size:24px;line-height:32px;vertical-align:middle">🎙️</span><span style="display:inline-block;width:8px"></span><span style="font-size:18px;line-height:28px;font-weight:700;letter-spacing:-0.45px;color:#f4f4f5;vertical-align:middle">Open Lounge</span></a></td></tr>
<tr><td style="background-color:#ecfdf5;background-image:linear-gradient(180deg,#d1fae5 0%,#ffffff 100%);padding:28px 32px 8px">
<div style="font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.02em">Your receipt${esc(sandbox)}</div>
<div style="font-size:15px;line-height:22px;color:#047857;padding-top:6px">Thanks for your purchase from Open Lounge.</div></td></tr>
<tr><td style="padding:12px 32px 8px"><table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">
${row("Item", esc(itemLabel))}${row("Amount", `<b>${esc(price)}</b>`)}${row("Paid with", esc(via))}${row("Seller", "Open Lounge")}${row("Order", esc(o.id))}${row("Date", esc(when))}
</table></td></tr>
<tr><td style="font-size:13px;line-height:20px;color:#52525b;padding:12px 32px 8px">${prod ? `<a href="${manage}" style="color:#047857">Manage it here</a>.` : `Your stickers are in <b>My stickers</b> on every device you sign in to. <a href="${manage}" style="color:#047857">Restore purchases</a>.`} Questions or a refund? Just reply to this email.</td></tr>
<tr><td style="font-size:15px;line-height:22px;padding:12px 32px 28px">See you in the lounge,<br><span style="font-weight:600">The Open Lounge team</span></td></tr>
</table>
<p style="font-size:12px;line-height:18px;color:#71717a;margin:16px 0 0">Open Lounge · <a href="${SITE}" style="color:#71717a">openlounge.app</a> · <a href="${SITE}/terms" style="color:#71717a">Terms</a> · <a href="${SITE}/privacy" style="color:#71717a">Privacy</a></p>
</td></tr></table></body></html>`;
      const sent = await this.mailer({ to, subject: `Your Open Lounge receipt: ${prod ? prod.title(o.packId) : (p?.title ?? "Sticker pack")} (${price})`, text, html });
      if (sent) await this.repo.update(o.id, { receiptSentAt: Date.now() });
    } catch (err) {
      console.error("[stickers] receipt email failed", (err as Error).message);
    }
  }
}

let instance: StickerService | null = null;
export function stickers(): StickerService {
  if (!instance) instance = new StickerService();
  return instance;
}
export function setStickerService(s: StickerService | null) {
  instance = s;
}
