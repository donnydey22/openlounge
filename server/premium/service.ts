// Open Lounge Premium (flag PREMIUM_ENABLED, off by default; sandbox only until Donny decides otherwise).
// Sold on the WEB only through the shared PayPal pipeline in server/stickers/service.ts:
//   - one-time passes "premium:month" / "premium:year" (Orders v2; same create/capture/webhook/receipt/restore/refund)
//   - optional auto-renew via the PayPal Subscriptions API when PAYPAL_PREMIUM_PLAN_MONTH / _YEAR are set
// Membership = latest non-revoked grant end. Grants are idempotent per order/sale id.
// Perks: Premium-exclusive sticker packs, profile badge, bigger upload + longer expiring-file limits (limitsFor),
// custom app icons (prefs.appIcon + native hook spec in docs/native-app-icons.md) and early features (isEarly).
import { randomBytes } from "node:crypto";
import { Collection, flag } from "../monet/db";
import { stickers, type ProductHandler } from "../stickers/service";
import { store } from "../store";
import type { OrderRow } from "../stickers/repo";
import { APP_ICONS, FREE_LIMITS, PREMIUM_LIMITS, type EarlyFeature, type Limits, type PremiumConfig, type PremiumMe, type PremiumPlan, type PremiumPrefs } from "../../src/lib/premium/types";

const DAY = 86_400_000;
const DAYS: Record<PremiumPlan, number> = { month: 31, year: 366 };
const SITE = process.env.AUTH_PUBLIC_URL?.replace(/\/$/, "") || "https://openlounge.app";

interface Grant {
  id: string; // order id / PayPal sale id / "admin-…"
  userId: string;
  plan: PremiumPlan;
  startsAt: number;
  endsAt: number;
  revokedAt: number | null;
  source: "order" | "subscription" | "grant";
  subscriptionId: string | null;
  createdAt: number;
}
interface Sub {
  id: string; // PayPal subscription id
  userId: string;
  plan: PremiumPlan;
  status: string; // APPROVAL_PENDING | ACTIVE | SUSPENDED | CANCELLED | EXPIRED
  createdAt: number;
  updatedAt: number;
}
interface Prefs extends PremiumPrefs {
  id: string; // userId
}

export const EARLY_FEATURES: EarlyFeature[] = [
  { id: "stage-reactions", name: "Stage reactions", description: "Send animated reactions to speakers on stage." },
  { id: "room-themes", name: "Room themes", description: "Pick a color theme for rooms you host." },
];

export class PremiumService {
  grants = new Collection<Grant>("premium_grants", ["userId", "endsAt"]);
  subs = new Collection<Sub>("premium_subscriptions", ["userId", "status"]);
  prefs = new Collection<Prefs>("premium_prefs");
  private ready = false;
  constructor(private env: Record<string, string | undefined> = process.env) {}

  get enabled() {
    return flag(this.env.PREMIUM_ENABLED);
  }
  price(plan: PremiumPlan) {
    const v = Number(plan === "month" ? this.env.PREMIUM_MONTH_CENTS : this.env.PREMIUM_YEAR_CENTS);
    return Number.isInteger(v) && v > 0 ? v : plan === "month" ? 499 : 3999;
  }
  planId(plan: PremiumPlan) {
    return (plan === "month" ? this.env.PAYPAL_PREMIUM_PLAN_MONTH : this.env.PAYPAL_PREMIUM_PLAN_YEAR) || null;
  }

  async init() {
    if (this.ready) return;
    await Promise.all([this.grants.load(), this.subs.load(), this.prefs.load()]);
    const svc = stickers();
    svc.isPremium = (uid) => this.isPremium(uid);
    svc.premiumVisible = () => this.enabled;
    svc.registerProduct("premium", this.product());
    this.ready = true;
  }

  // ---------- membership ----------
  endOf(userId: string) {
    let end = 0;
    for (const g of this.grants.rows.values()) if (g.userId === userId && !g.revokedAt && g.endsAt > end) end = g.endsAt;
    return end;
  }
  /** Perks only apply while Premium is switched on. */
  isPremium(userId: string, now = Date.now()) {
    return this.enabled && this.endOf(userId) > now;
  }
  limitsFor(userId: string): Limits {
    return this.isPremium(userId) ? PREMIUM_LIMITS : FREE_LIMITS;
  }
  isEarly(userId: string, featureId: string) {
    return this.isPremium(userId) && EARLY_FEATURES.some((f) => f.id === featureId);
  }
  badge(userId: string) {
    return this.isPremium(userId) && this.prefs.get(userId)?.badgeVisible !== false;
  }

  async grant(userId: string, id: string, plan: PremiumPlan, source: Grant["source"], subscriptionId: string | null = null) {
    const existing = this.grants.get(id);
    if (existing) return existing; // idempotent (restore, webhook retries, capture + webhook)
    const now = Date.now();
    const startsAt = Math.max(now, this.endOf(userId));
    return this.grants.put({ id, userId, plan, startsAt, endsAt: startsAt + DAYS[plan] * DAY, revokedAt: null, source, subscriptionId, createdAt: now });
  }
  async revoke(id: string) {
    const g = this.grants.get(id);
    if (!g || g.revokedAt) return;
    await this.grants.put({ ...g, revokedAt: Date.now() });
  }

  async adminGrant(by: string, b: Record<string, unknown>) {
    const userId = typeof b.userId === "string" ? b.userId : "";
    if (!store.users.get(userId)) return { ok: false as const, status: 404, error: "User not found" };
    const plan: PremiumPlan = b.plan === "year" ? "year" : "month";
    const g = await this.grant(userId, `admin-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, plan, "grant");
    console.log(`[premium] admin ${by} granted ${plan} to ${userId}`);
    return { ok: true as const, grant: g, me: this.me(userId) };
  }
  async adminRevoke(b: Record<string, unknown>) {
    const userId = typeof b.userId === "string" ? b.userId : "";
    const gs = this.grants.where((g) => g.userId === userId && g.source === "grant" && !g.revokedAt);
    for (const g of gs) await this.revoke(g.id);
    return { ok: true as const, revoked: gs.length, me: this.me(userId) };
  }

  config(): PremiumConfig {
    const svc = stickers();
    return {
      enabled: this.enabled,
      checkout: this.enabled && svc.paidEnabled,
      subscriptions: this.enabled && svc.paidEnabled ? (["month", "year"] as PremiumPlan[]).filter((p) => !!this.planId(p)) : [],
      prices: { month: this.price("month"), year: this.price("year") },
      currency: "USD",
      free: FREE_LIMITS,
      premium: PREMIUM_LIMITS,
      icons: APP_ICONS,
      early: EARLY_FEATURES,
      mode: svc.paypal?.cfg.mode ?? "sandbox",
    };
  }

  me(userId: string): PremiumMe {
    const active = this.isPremium(userId);
    const live = [...this.grants.rows.values()].filter((g) => g.userId === userId && !g.revokedAt).sort((a, b) => b.endsAt - a.endsAt)[0];
    const sub = [...this.subs.rows.values()].filter((s) => s.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const p = this.prefs.get(userId);
    return {
      active,
      endsAt: live && live.endsAt > Date.now() ? live.endsAt : null,
      plan: live?.plan ?? null,
      source: live?.source ?? null,
      autoRenew: sub?.status === "ACTIVE",
      subscriptionId: sub?.status === "ACTIVE" ? sub.id : null,
      prefs: { appIcon: p?.appIcon ?? "classic", badgeVisible: p?.badgeVisible !== false },
      limits: this.limitsFor(userId),
    };
  }

  async setPrefs(userId: string, body: Record<string, unknown>) {
    const cur = this.prefs.get(userId) ?? { id: userId, appIcon: "classic", badgeVisible: true };
    const next = { ...cur };
    if (typeof body.appIcon === "string") {
      const icon = APP_ICONS.find((i) => i.id === body.appIcon);
      if (!icon) return { ok: false as const, status: 400, error: "Unknown app icon" };
      if (icon.premium && !this.isPremium(userId)) return { ok: false as const, status: 402, error: "That icon comes with Open Lounge Premium" };
      next.appIcon = icon.id;
    }
    if (typeof body.badgeVisible === "boolean") next.badgeVisible = body.badgeVisible;
    await this.prefs.put(next);
    return { ok: true as const, me: this.me(userId) };
  }

  // ---------- PayPal: one-time passes through the shared pipeline ----------
  product(): ProductHandler {
    const planOf = (ref: string): PremiumPlan | null => (ref === "premium:month" ? "month" : ref === "premium:year" ? "year" : null);
    return {
      manageUrl: "/premium",
      title: (ref) => `Open Lounge Premium (${planOf(ref) === "year" ? "1 year" : "1 month"})`,
      quote: (_userId, ref) => {
        const plan = planOf(ref);
        if (!this.enabled) return { ok: false, status: 503, error: "Open Lounge Premium isn't available yet" };
        if (!plan) return { ok: false, status: 404, error: "Unknown plan" };
        return { ok: true, amountCents: this.price(plan), currency: "USD", title: `Open Lounge Premium (${plan === "year" ? "1 year" : "1 month"})` };
      },
      fulfil: async (o: OrderRow) => {
        const plan = planOf(o.packId);
        if (plan) await this.grant(o.userId, o.id, plan, "order");
      },
      revoke: async (o: OrderRow) => this.revoke(o.id),
      webhook: (e) => this.subscriptionWebhook(e),
    };
  }

  // ---------- PayPal: auto-renew subscriptions (only when plan ids are configured) ----------
  async subscribe(userId: string, planRaw: unknown, opts: { wrapper?: boolean } = {}) {
    const svc = stickers();
    const plan = planRaw === "year" ? "year" : planRaw === "month" ? "month" : null;
    if (!this.enabled || !svc.paidEnabled || !svc.paypal) return { ok: false as const, status: 503, error: "Open Lounge Premium isn't available yet" };
    if (opts.wrapper) return { ok: false as const, status: 403, error: "Subscribe on openlounge.app" };
    if (!plan || !this.planId(plan)) return { ok: false as const, status: 400, error: "Auto-renew isn't available for that plan" };
    try {
      const s = await svc.paypal.createSubscription({
        planId: this.planId(plan)!,
        customId: `${userId}|premium:${plan}`,
        requestId: `sub-${userId}-${plan}-${randomBytes(6).toString("hex")}`,
        brand: "Open Lounge",
        returnUrl: `${SITE}/premium?sub=return`,
        cancelUrl: `${SITE}/premium?sub=cancel`,
      });
      const now = Date.now();
      await this.subs.put({ id: s.id, userId, plan, status: s.status || "APPROVAL_PENDING", createdAt: now, updatedAt: now });
      const approve = s.links?.find((l) => l.rel === "approve")?.href ?? null;
      return { ok: true as const, subscriptionId: s.id, approveUrl: approve };
    } catch (err) {
      console.error("[premium] create subscription failed", (err as Error).message);
      return { ok: false as const, status: 502, error: "Couldn't start the subscription. Please try again." };
    }
  }

  /** After the buyer returns from PayPal: re-read the subscription (no webhook needed to show status). */
  async syncSubscription(userId: string, id: unknown) {
    const svc = stickers();
    const sub = typeof id === "string" ? this.subs.get(id) : null;
    if (!sub || sub.userId !== userId || !svc.paypal) return { ok: false as const, status: 404, error: "Subscription not found" };
    try {
      const s = await svc.paypal.getSubscription(sub.id);
      await this.subs.put({ ...sub, status: s.status, updatedAt: Date.now() });
      // first period: PayPal bills at activation; the PAYMENT.SALE.COMPLETED webhook grants it. If that hasn't
      // arrived yet, grant the first period keyed by the subscription id so the buyer isn't left waiting.
      if (s.status === "ACTIVE" && !this.grants.where((g) => g.subscriptionId === sub.id).length) await this.grant(userId, `sub-first-${sub.id}`, sub.plan, "subscription", sub.id);
    } catch (err) {
      return { ok: false as const, status: 502, error: (err as Error).message };
    }
    return { ok: true as const, me: this.me(userId) };
  }

  async cancel(userId: string) {
    const svc = stickers();
    const sub = [...this.subs.rows.values()].find((s) => s.userId === userId && s.status === "ACTIVE");
    if (!sub || !svc.paypal) return { ok: false as const, status: 404, error: "No active subscription" };
    try {
      await svc.paypal.cancelSubscription(sub.id, "Cancelled from Open Lounge");
    } catch (err) {
      return { ok: false as const, status: 502, error: (err as Error).message };
    }
    await this.subs.put({ ...sub, status: "CANCELLED", updatedAt: Date.now() });
    return { ok: true as const, me: this.me(userId) }; // paid time runs to the end of the period
  }

  async subscriptionWebhook(e: { event_type?: string; resource?: Record<string, unknown> }): Promise<boolean> {
    const r = e.resource ?? {};
    const t = e.event_type ?? "";
    if (t.startsWith("BILLING.SUBSCRIPTION.")) {
      const sub = typeof r.id === "string" ? this.subs.get(r.id) : null;
      if (sub) await this.subs.put({ ...sub, status: String(r.status ?? t.split(".").pop()), updatedAt: Date.now() });
      return true;
    }
    if (t === "PAYMENT.SALE.COMPLETED" && typeof r.billing_agreement_id === "string") {
      const sub = this.subs.get(r.billing_agreement_id);
      if (!sub || typeof r.id !== "string") return true;
      // if the first period was granted on return (sync), the first sale replaces it instead of stacking
      const first = this.grants.get(`sub-first-${sub.id}`);
      if (first && !this.grants.where((g) => g.subscriptionId === sub.id && g.id !== first.id).length) {
        await this.grants.put({ ...first, revokedAt: Date.now() });
        await this.grants.put({ ...first, id: r.id, revokedAt: null, createdAt: Date.now() });
      } else await this.grant(sub.userId, r.id, sub.plan, "subscription", sub.id);
      return true;
    }
    if ((t === "PAYMENT.SALE.REFUNDED" || t === "PAYMENT.SALE.REVERSED") && typeof r.sale_id === "string") {
      await this.revoke(r.sale_id);
      return true;
    }
    if (t === "PAYMENT.SALE.REVERSED" && typeof r.id === "string") {
      await this.revoke(r.id);
      return true;
    }
    return false;
  }
}

let instance: PremiumService | null = null;
export function premium(): PremiumService {
  if (!instance) instance = new PremiumService();
  return instance;
}
export function setPremiumService(p: PremiumService | null) {
  instance = p;
}
