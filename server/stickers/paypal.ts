// PayPal REST: Orders v2 (server-side create + capture) and webhook signature verification.
// Sandbox unless PAYPAL_MODE=live. Credentials: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, webhook: PAYPAL_WEBHOOK_ID.
// Docs: https://developer.paypal.com/docs/api/orders/v2/ · https://developer.paypal.com/api/rest/webhooks/rest/

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  mode: "sandbox" | "live";
  webhookId: string | null;
}

export function paypalConfigFromEnv(env: Record<string, string | undefined> = process.env): PayPalConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, mode: env.PAYPAL_MODE?.trim().toLowerCase() === "live" ? "live" : "sandbox", webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null };
}

export const apiBase = (mode: "sandbox" | "live") => (mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly issue: string | null,
    readonly body: unknown,
  ) {
    super(`PayPal ${status}${issue ? ` ${issue}` : ""}`);
  }
}

export interface PayPalOrder {
  id: string;
  status: string; // CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED
  payer?: { email_address?: string };
  payment_source?: Record<string, unknown>;
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    payments?: { captures?: { id: string; status: string; amount?: { value: string; currency_code: string } }[] };
  }[];
}

/** Default "OPENLOUNGE"; sanitised to PayPal's charset and 22 chars. */
export function softDescriptor(env: Record<string, string | undefined> = process.env) {
  const v = env.PAYPAL_SOFT_DESCRIPTOR ?? "OPENLOUNGE";
  return v.replace(/[^A-Za-z0-9 .*-]/g, "").trim().slice(0, 22);
}

export class PayPalClient {
  private token: { value: string; exp: number } | null = null;
  constructor(
    readonly cfg: PayPalConfig,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  get base() {
    return apiBase(this.cfg.mode);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.value;
    const r = await this.fetchFn(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!r.ok || !j.access_token) throw new PayPalError(r.status, "AUTH_FAILED", j);
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 300) * 1000 };
    return j.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, requestId?: string, rawJson?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId; // idempotency key: retries return the original result
    const r = await this.fetchFn(`${this.base}${path}`, { method, headers, body: rawJson ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as T & { details?: { issue?: string }[]; name?: string };
    if (!r.ok) throw new PayPalError(r.status, j?.details?.[0]?.issue ?? j?.name ?? null, j);
    return j;
  }

  createOrder(o: { requestId: string; funding?: string; amountCents: number; currency: string; packId: string; userId: string; title: string; itemName?: string; brand: string; returnUrl?: string; cancelUrl?: string }) {
    const item = (o.itemName ?? `Open Lounge sticker pack: ${o.title}`).slice(0, 127);
    const value = (o.amountCents / 100).toFixed(2);
    return this.call<PayPalOrder>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: o.packId,
            custom_id: `${o.userId}|${o.packId}`.slice(0, 127),
            description: item,
            // Card statement = "PAYPAL *" + profile merchant descriptor + " " + soft_descriptor, cut at 22 chars (PayPal
            // Orders v2 docs). ASCII letters/digits/space/.-* only. PAYPAL_SOFT_DESCRIPTOR="" omits it (e.g. once the
            // profile descriptor itself reads OPENLOUNGE, to avoid "PAYPAL *OPENLOUNGE OPEN").
            ...(softDescriptor() ? { soft_descriptor: softDescriptor() } : {}),
            amount: { currency_code: o.currency, value, breakdown: { item_total: { currency_code: o.currency, value } } },
            items: [{ name: item, quantity: "1", sku: o.packId.slice(0, 127), category: "DIGITAL_GOODS", unit_amount: { currency_code: o.currency, value } }],
          },
        ],
        // PayPal button: wallet experience context. Apple Pay / Google Pay attach their payment source client-side
        // via confirmOrder(), so the order is created without one.
        ...((o.funding ?? "paypal") === "paypal" ? { payment_source: {
          paypal: {
            experience_context: {
              brand_name: o.brand,
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              ...(o.returnUrl ? { return_url: o.returnUrl, cancel_url: o.cancelUrl ?? o.returnUrl } : {}),
            },
          },
        } } : {}),
      },
      o.requestId,
    );
  }

  /** Same order id → same PayPal-Request-Id, so a retried capture never charges twice. */
  captureOrder(orderId: string) {
    return this.call<PayPalOrder>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`);
  }

  getOrder(orderId: string) {
    return this.call<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  // ---- Subscriptions API (Premium auto-renew). Plans are created by Donny in PayPal; ids come from env. ----
  createSubscription(o: { planId: string; customId: string; requestId: string; brand: string; returnUrl: string; cancelUrl: string }) {
    return this.call<{ id: string; status: string; links?: { rel: string; href: string }[] }>(
      "POST",
      "/v1/billing/subscriptions",
      {
        plan_id: o.planId,
        custom_id: o.customId.slice(0, 127),
        application_context: { brand_name: o.brand, shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW", return_url: o.returnUrl, cancel_url: o.cancelUrl },
      },
      o.requestId,
    );
  }
  getSubscription(id: string) {
    return this.call<{ id: string; status: string; plan_id?: string; custom_id?: string; billing_info?: { next_billing_time?: string; last_payment?: { time?: string } } }>("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
  }
  async cancelSubscription(id: string, reason: string) {
    await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 128) });
  }

  /** POST /v1/notifications/verify-webhook-signature → true only on verification_status SUCCESS. */
  async verifyWebhook(headers: Record<string, string | string[] | undefined>, event: unknown, rawEvent?: string): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const body = {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: this.cfg.webhookId,
      webhook_event: event,
    };
    if (!body.transmission_id || !body.transmission_sig || !body.cert_url) return false;
    // The signature covers PayPal's exact bytes, so embed the raw event body rather than a re-serialisation.
    const raw = rawEvent ? JSON.stringify({ ...body, webhook_event: "__EVENT__" }).replace('"__EVENT__"', () => rawEvent) : undefined;
    try {
      const r = await this.call<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", body, undefined, raw);
      return r.verification_status === "SUCCESS";
    } catch {
      return false;
    }
  }
}

/** First capture of an order (status + id). */
export function captureOf(o: PayPalOrder) {
  return o.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}

/** paypal | apple_pay | google_pay | card | venmo … from an order's payment_source */
export function fundingOf(o: PayPalOrder): string | null {
  const k = Object.keys(o.payment_source ?? {})[0];
  return k ?? null;
}
