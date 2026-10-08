// Sticker persistence: Postgres (DATABASE_URL, migration 016_stickers.sql) or memory (local dev / tests).
import pg from "pg";
import { chooseSsl } from "../pg";
import type { StickerPack, Receipt } from "../../src/lib/stickers/types";

export type OrderStatus = Receipt["status"];
export interface OrderRow {
  id: string;
  userId: string;
  packId: string;
  amountCents: number;
  currency: string;
  status: OrderStatus;
  captureId: string | null;
  fundingSource: string | null;
  payerEmail: string | null;
  mode: "sandbox" | "live";
  createdAt: number;
  capturedAt: number | null;
  refundedAt: number | null;
  receiptSentAt: number | null;
}
export interface Ref {
  packId: string;
  stickerId: string;
}
export const RECENTS_MAX = 30;
export const FAVORITES_MAX = 100;

export interface StickerRepo {
  kind: "postgres" | "memory";
  listPacks(): Promise<StickerPack[]>;
  savePack(p: StickerPack, by: string | null): Promise<void>;
  mine(userId: string): Promise<{ added: string[]; favorites: Ref[]; recents: Ref[] }>;
  setAdded(userId: string, packId: string, add: boolean): Promise<void>;
  reorder(userId: string, packIds: string[]): Promise<void>;
  setFavorite(userId: string, ref: Ref, fav: boolean): Promise<void>;
  addRecent(userId: string, ref: Ref): Promise<void>;
  /** insert if absent; returns the stored row */
  createOrder(o: OrderRow): Promise<OrderRow>;
  getOrder(id: string): Promise<OrderRow | null>;
  orderByCapture(captureId: string): Promise<OrderRow | null>;
  /** atomic compare-and-set on status (idempotent capture/refund). Returns the updated row or null if `from` didn't match. */
  transition(id: string, from: OrderStatus[], patch: Partial<OrderRow>): Promise<OrderRow | null>;
  update(id: string, patch: Partial<OrderRow>): Promise<void>;
  ordersOf(userId: string): Promise<OrderRow[]>;
  grant(userId: string, packId: string, orderId: string): Promise<void>;
  revoke(userId: string, packId: string, orderId: string): Promise<void>;
  allEntitlements(): Promise<{ userId: string; packId: string }[]>;
  /** true the first time an event id is seen */
  markEvent(id: string, type: string, resourceId: string | null): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryStickerRepo implements StickerRepo {
  kind = "memory" as const;
  packs = new Map<string, StickerPack>();
  added = new Map<string, { packId: string; position: number; at: number }[]>();
  favs = new Map<string, (Ref & { at: number })[]>();
  recents = new Map<string, (Ref & { at: number })[]>();
  orders = new Map<string, OrderRow>();
  ents = new Map<string, { orderId: string; revoked: boolean }>();
  events = new Set<string>();
  async listPacks() {
    return [...this.packs.values()].map((p) => structuredClone(p));
  }
  async savePack(p: StickerPack) {
    this.packs.set(p.id, structuredClone(p));
  }
  async mine(userId: string) {
    return {
      added: (this.added.get(userId) ?? []).slice().sort((a, b) => a.position - b.position || a.at - b.at).map((x) => x.packId),
      favorites: (this.favs.get(userId) ?? []).slice().sort((a, b) => b.at - a.at).map(({ packId, stickerId }) => ({ packId, stickerId })),
      recents: (this.recents.get(userId) ?? []).slice().sort((a, b) => b.at - a.at).map(({ packId, stickerId }) => ({ packId, stickerId })),
    };
  }
  async setAdded(userId: string, packId: string, add: boolean) {
    const l = (this.added.get(userId) ?? []).filter((x) => x.packId !== packId);
    if (add) l.unshift({ packId, position: Math.min(0, ...l.map((x) => x.position)) - 1, at: Date.now() });
    this.added.set(userId, l);
  }
  async reorder(userId: string, packIds: string[]) {
    const l = this.added.get(userId) ?? [];
    for (const x of l) {
      const i = packIds.indexOf(x.packId);
      if (i >= 0) x.position = i;
    }
  }
  async setFavorite(userId: string, ref: Ref, fav: boolean) {
    const l = (this.favs.get(userId) ?? []).filter((x) => !(x.packId === ref.packId && x.stickerId === ref.stickerId));
    if (fav) l.push({ ...ref, at: Date.now() });
    l.sort((a, b) => b.at - a.at);
    this.favs.set(userId, l.slice(0, FAVORITES_MAX));
  }
  private tick = 0;
  async addRecent(userId: string, ref: Ref) {
    const l = (this.recents.get(userId) ?? []).filter((x) => !(x.packId === ref.packId && x.stickerId === ref.stickerId));
    l.unshift({ ...ref, at: Date.now() * 1000 + (this.tick++ % 1000) });
    this.recents.set(userId, l.slice(0, RECENTS_MAX));
  }
  async createOrder(o: OrderRow) {
    if (!this.orders.has(o.id)) this.orders.set(o.id, { ...o });
    return { ...this.orders.get(o.id)! };
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? { ...o } : null;
  }
  async orderByCapture(captureId: string) {
    for (const o of this.orders.values()) if (o.captureId === captureId) return { ...o };
    return null;
  }
  async transition(id: string, from: OrderStatus[], patch: Partial<OrderRow>) {
    const o = this.orders.get(id);
    if (!o || !from.includes(o.status)) return null;
    Object.assign(o, patch);
    return { ...o };
  }
  async update(id: string, patch: Partial<OrderRow>) {
    const o = this.orders.get(id);
    if (o) Object.assign(o, patch);
  }
  async ordersOf(userId: string) {
    return [...this.orders.values()].filter((o) => o.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map((o) => ({ ...o }));
  }
  async grant(userId: string, packId: string, orderId: string) {
    this.ents.set(`${userId}|${packId}`, { orderId, revoked: false });
  }
  async revoke(userId: string, packId: string, orderId: string) {
    const e = this.ents.get(`${userId}|${packId}`);
    if (e && e.orderId === orderId) e.revoked = true;
  }
  async allEntitlements() {
    return [...this.ents.entries()].filter(([, e]) => !e.revoked).map(([k]) => {
      const [userId, packId] = k.split("|");
      return { userId, packId };
    });
  }
  async markEvent(id: string) {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }
  async close() {}
}

const COLS: Record<keyof OrderRow, string> = {
  id: "id",
  userId: "user_id",
  packId: "pack_id",
  amountCents: "amount_cents",
  currency: "currency",
  status: "status",
  captureId: "capture_id",
  fundingSource: "funding_source",
  payerEmail: "payer_email",
  mode: "mode",
  createdAt: "created_at",
  capturedAt: "captured_at",
  refundedAt: "refunded_at",
  receiptSentAt: "receipt_sent_at",
};
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
function rowToOrder(r: Record<string, unknown>): OrderRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    packId: String(r.pack_id),
    amountCents: Number(r.amount_cents),
    currency: String(r.currency),
    status: r.status as OrderStatus,
    captureId: (r.capture_id as string) ?? null,
    fundingSource: (r.funding_source as string) ?? null,
    payerEmail: (r.payer_email as string) ?? null,
    mode: (r.mode as "sandbox" | "live") ?? "sandbox",
    createdAt: Number(r.created_at),
    capturedAt: num(r.captured_at),
    refundedAt: num(r.refunded_at),
    receiptSentAt: num(r.receipt_sent_at),
  };
}
function setClause(patch: Partial<OrderRow>, start: number) {
  const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof OrderRow)[];
  return { sql: keys.map((k, i) => `${COLS[k]} = $${start + i}`).join(", "), vals: keys.map((k) => patch[k]) };
}

export class PgStickerRepo implements StickerRepo {
  kind = "postgres" as const;
  private pool: pg.Pool;
  constructor(url: string) {
    const { connectionString, ssl } = chooseSsl(url);
    this.pool = new pg.Pool({ connectionString, ssl, max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
    this.pool.on("error", (e) => console.warn("[stickers] pg idle error:", e.message));
  }
  private q<R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.pool.query<R>(sql, params).then((r) => r.rows);
  }
  async listPacks() {
    const rows = await this.q("SELECT * FROM sticker_packs ORDER BY created_at");
    return rows.map(
      (r): StickerPack => ({
        id: String(r.id),
        title: String(r.title),
        emoji: String(r.emoji),
        category: String(r.category),
        description: String(r.description),
        priceCents: num(r.price_cents),
        premium: !!r.premium,
        currency: String(r.currency),
        published: !!r.published,
        cover: (r.cover as string) ?? "",
        attribution: (r.attribution as StickerPack["attribution"]) ?? null,
        stickers: (r.stickers as StickerPack["stickers"]) ?? [],
      }),
    );
  }
  async savePack(p: StickerPack, by: string | null) {
    const now = Date.now();
    await this.q(
      `INSERT INTO sticker_packs (id, title, emoji, category, description, price_cents, currency, published, cover, attribution, stickers, created_by, created_at, updated_at, premium)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, emoji=EXCLUDED.emoji, category=EXCLUDED.category, description=EXCLUDED.description,
         price_cents=EXCLUDED.price_cents, currency=EXCLUDED.currency, published=EXCLUDED.published, cover=EXCLUDED.cover,
         attribution=EXCLUDED.attribution, stickers=EXCLUDED.stickers, updated_at=EXCLUDED.updated_at, premium=EXCLUDED.premium`,
      [p.id, p.title, p.emoji, p.category, p.description, p.priceCents, p.currency, p.published, p.cover, p.attribution ? JSON.stringify(p.attribution) : null, JSON.stringify(p.stickers), by, now, !!p.premium],
    );
  }
  async mine(userId: string) {
    const [a, f, r] = await Promise.all([
      this.q("SELECT pack_id FROM sticker_user_packs WHERE user_id=$1 ORDER BY position, added_at DESC", [userId]),
      this.q("SELECT pack_id, sticker_id FROM sticker_favorites WHERE user_id=$1 ORDER BY added_at DESC LIMIT $2", [userId, FAVORITES_MAX]),
      this.q("SELECT pack_id, sticker_id FROM sticker_recents WHERE user_id=$1 ORDER BY used_at DESC LIMIT $2", [userId, RECENTS_MAX]),
    ]);
    const ref = (x: Record<string, unknown>) => ({ packId: String(x.pack_id), stickerId: String(x.sticker_id) });
    return { added: a.map((x) => String(x.pack_id)), favorites: f.map(ref), recents: r.map(ref) };
  }
  async setAdded(userId: string, packId: string, add: boolean) {
    if (!add) return void (await this.q("DELETE FROM sticker_user_packs WHERE user_id=$1 AND pack_id=$2", [userId, packId]));
    await this.q(
      `INSERT INTO sticker_user_packs (user_id, pack_id, position, added_at)
       VALUES ($1, $2, COALESCE((SELECT MIN(position) FROM sticker_user_packs WHERE user_id=$1), 0) - 1, $3)
       ON CONFLICT (user_id, pack_id) DO NOTHING`,
      [userId, packId, Date.now()],
    );
  }
  async reorder(userId: string, packIds: string[]) {
    await this.q(
      `UPDATE sticker_user_packs u SET position = o.pos FROM unnest($2::text[]) WITH ORDINALITY AS o(pack_id, pos)
       WHERE u.user_id=$1 AND u.pack_id=o.pack_id`,
      [userId, packIds],
    );
  }
  async setFavorite(userId: string, ref: Ref, fav: boolean) {
    if (!fav) return void (await this.q("DELETE FROM sticker_favorites WHERE user_id=$1 AND pack_id=$2 AND sticker_id=$3", [userId, ref.packId, ref.stickerId]));
    await this.q(
      "INSERT INTO sticker_favorites (user_id, pack_id, sticker_id, added_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [userId, ref.packId, ref.stickerId, Date.now()],
    );
  }
  async addRecent(userId: string, ref: Ref) {
    await this.q(
      "INSERT INTO sticker_recents (user_id, pack_id, sticker_id, used_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, pack_id, sticker_id) DO UPDATE SET used_at=EXCLUDED.used_at",
      [userId, ref.packId, ref.stickerId, Date.now()],
    );
    await this.q(
      `DELETE FROM sticker_recents WHERE user_id=$1 AND (pack_id, sticker_id) NOT IN
         (SELECT pack_id, sticker_id FROM sticker_recents WHERE user_id=$1 ORDER BY used_at DESC LIMIT $2)`,
      [userId, RECENTS_MAX],
    );
  }
  async createOrder(o: OrderRow) {
    await this.q(
      `INSERT INTO sticker_orders (id, user_id, pack_id, amount_cents, currency, status, capture_id, funding_source, payer_email, mode, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [o.id, o.userId, o.packId, o.amountCents, o.currency, o.status, o.captureId, o.fundingSource, o.payerEmail, o.mode, o.createdAt],
    );
    return (await this.getOrder(o.id))!;
  }
  async getOrder(id: string) {
    const r = await this.q("SELECT * FROM sticker_orders WHERE id=$1", [id]);
    return r[0] ? rowToOrder(r[0]) : null;
  }
  async orderByCapture(captureId: string) {
    const r = await this.q("SELECT * FROM sticker_orders WHERE capture_id=$1", [captureId]);
    return r[0] ? rowToOrder(r[0]) : null;
  }
  async transition(id: string, from: OrderStatus[], patch: Partial<OrderRow>) {
    const { sql, vals } = setClause(patch, 3);
    const r = await this.q(`UPDATE sticker_orders SET ${sql} WHERE id=$1 AND status = ANY($2::text[]) RETURNING *`, [id, from, ...vals]);
    return r[0] ? rowToOrder(r[0]) : null;
  }
  async update(id: string, patch: Partial<OrderRow>) {
    const { sql, vals } = setClause(patch, 2);
    if (sql) await this.q(`UPDATE sticker_orders SET ${sql} WHERE id=$1`, [id, ...vals]);
  }
  async ordersOf(userId: string) {
    return (await this.q("SELECT * FROM sticker_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200", [userId])).map(rowToOrder);
  }
  async grant(userId: string, packId: string, orderId: string) {
    await this.q(
      `INSERT INTO sticker_entitlements (user_id, pack_id, order_id, granted_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, pack_id) DO UPDATE SET order_id=EXCLUDED.order_id, granted_at=EXCLUDED.granted_at, revoked_at=NULL
       WHERE sticker_entitlements.revoked_at IS NOT NULL OR sticker_entitlements.order_id = EXCLUDED.order_id`,
      [userId, packId, orderId, Date.now()],
    );
  }
  async revoke(userId: string, packId: string, orderId: string) {
    await this.q("UPDATE sticker_entitlements SET revoked_at=$4 WHERE user_id=$1 AND pack_id=$2 AND order_id=$3 AND revoked_at IS NULL", [userId, packId, orderId, Date.now()]);
  }
  async allEntitlements() {
    return (await this.q("SELECT user_id, pack_id FROM sticker_entitlements WHERE revoked_at IS NULL")).map((r) => ({ userId: String(r.user_id), packId: String(r.pack_id) }));
  }
  async markEvent(id: string, type: string, resourceId: string | null) {
    const r = await this.q("INSERT INTO paypal_webhook_events (id, event_type, resource_id, received_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [id, type, resourceId, Date.now()]);
    return r.length > 0;
  }
  async close() {
    await this.pool.end();
  }
}
