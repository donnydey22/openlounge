// Business & creator accounts (flag CREATOR_ENABLED, off by default).
//  - Paid verification badge: apply with an ID document (+ business document for businesses), pay the fee on the web
//    through the shared PayPal pipeline (product "verify:<kind>:<requestId>"; sandbox until Donny decides), then admin
//    review. Documents are private on the volume, admin-only, and deleted as soon as the request is decided.
//    Refund before approval → rejected; refund/chargeback after approval → badge revoked.
//  - Analytics for creator accounts: a 60 s sampler over live rooms they host records unique listeners, peak
//    concurrency, listener-minutes, a concurrency curve and retention (share still there 5/15/30/60 min after
//    joining), plus a daily follower snapshot. Replays: counter hook only (no recordings exist yet).
//  - Branded rooms: logo, colors, cover, custom link openlounge.app/r/<slug>, co-host list, scheduled series.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Collection, flag } from "../monet/db";
import { DATA_DIR } from "../persistence";
import { store } from "../store";
import { stickers, type ProductHandler } from "../stickers/service";
import type { OrderRow } from "../stickers/repo";
import type { AccountType, Branding, CreatorAnalytics, CreatorConfig, CreatorProfile, RoomSession, Series, VerificationRequest } from "../../src/lib/creator/types";

export const CREATOR_FILES = path.resolve(process.env.CREATOR_FILES_DIR || path.join(DATA_DIR, "creator-files"));
export const VERIFY_DOCS = path.resolve(process.env.VERIFY_DOCS_DIR || path.join(DATA_DIR, "verify-docs"));
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim()
    .slice(0, max);
const HEX = /^#[0-9a-fA-F]{6}$/;
const RESERVED = new Set(["admin", "api", "app", "openlounge", "support", "help", "premium", "stickers", "settings", "login", "signup", "room", "rooms", "explore", "messages", "terms", "privacy", "about", "official"]);

interface Live {
  hostId: string;
  first: Map<string, number>; // userId → first seen
  last: Map<string, number>; // userId → last seen
  minutes: number;
  peak: number;
  curve: [number, number][];
  lastTick: number;
}
interface FollowerDay {
  id: string; // "<userId>|<day>"
  userId: string;
  day: string;
  followers: number;
}

export class CreatorService {
  profiles = new Collection<CreatorProfile>("creator_profiles");
  requests = new Collection<VerificationRequest>("verification_requests", ["userId", "status"]);
  badges = new Collection<{ id: string; verified: AccountType; since: number; requestId: string }>("user_badges");
  branding = new Collection<Branding>("room_branding", ["slug"]);
  series = new Collection<Series>("room_series", ["hostId"]);
  sessions = new Collection<RoomSession>("creator_room_sessions", ["hostId"]);
  followerDays = new Collection<FollowerDay>("creator_follower_daily", ["userId", "day"]);
  private live = new Map<string, Live>();
  private timer: NodeJS.Timeout | null = null;
  private lastFollowerAt = 0;
  private ready = false;
  constructor(private env: Record<string, string | undefined> = process.env) {}

  get enabled() {
    return flag(this.env.CREATOR_ENABLED);
  }
  fee(kind: AccountType) {
    const v = Number(kind === "business" ? this.env.VERIFY_BUSINESS_CENTS : this.env.VERIFY_CREATOR_CENTS);
    return Number.isInteger(v) && v > 0 ? v : kind === "business" ? 4999 : 1499;
  }
  get feeWaived() {
    return flag(this.env.VERIFY_FEE_WAIVED);
  }

  async init(opts: { sampler?: boolean } = {}) {
    if (this.ready) return;
    await Promise.all([this.profiles.load(), this.requests.load(), this.badges.load(), this.branding.load(), this.series.load(), this.sessions.load(), this.followerDays.load()]);
    stickers().registerProduct("verify", this.product());
    this.ready = true;
    if (opts.sampler !== false && !this.timer) {
      this.timer = setInterval(() => {
        if (this.enabled) void this.sample().catch((e) => console.warn("[creator] sample failed", (e as Error).message));
      }, 60_000);
      this.timer.unref?.();
    }
  }

  config(): CreatorConfig {
    return { enabled: this.enabled, checkout: this.enabled && stickers().paidEnabled, fees: { creator: this.fee("creator"), business: this.fee("business") }, feeWaived: this.feeWaived, replays: false };
  }

  verifiedOf(uid: string): AccountType | null {
    if (!this.enabled) return null;
    return this.badges.get(uid)?.verified ?? null;
  }

  // ---------- creator account ----------
  async setProfile(uid: string, b: Record<string, unknown>) {
    if (!this.enabled) return { ok: false as const, status: 503, error: "Creator accounts aren't available yet" };
    const cur = this.profiles.get(uid);
    const type: AccountType = b.type === "business" ? "business" : b.type === "creator" ? "creator" : (cur?.type ?? "creator");
    const p: CreatorProfile = { id: uid, type, enabled: b.enabled !== false, createdAt: cur?.createdAt ?? Date.now() };
    await this.profiles.put(p);
    return { ok: true as const, profile: p };
  }
  isCreator(uid: string) {
    return !!this.profiles.get(uid)?.enabled;
  }

  me(uid: string) {
    const reqs = this.requests.where((r) => r.userId === uid).sort((a, b) => b.createdAt - a.createdAt);
    return {
      profile: this.profiles.get(uid),
      verified: this.verifiedOf(uid),
      request: reqs[0] ? this.publicRequest(reqs[0]) : null,
      branding: this.branding.get(uid),
      series: this.series.where((s) => s.hostId === uid),
    };
  }
  private publicRequest(r: VerificationRequest) {
    return { ...r, docs: r.docs.map((d) => ({ id: d.id, label: d.label, mime: d.mime })) };
  }

  // ---------- verification ----------
  async apply(uid: string, b: Record<string, unknown>) {
    if (!this.enabled) return { ok: false as const, status: 503, error: "Verification isn't available yet" };
    if (this.badges.get(uid)) return { ok: false as const, status: 409, error: "You're already verified" };
    const open = this.requests.where((r) => r.userId === uid && (r.status === "pending" || r.status === "awaiting_payment"));
    if (open.some((r) => r.status === "pending")) return { ok: false as const, status: 409, error: "Your request is being reviewed" };
    const kind: AccountType = b.kind === "business" ? "business" : "creator";
    const legalName = clean(b.legalName, 120);
    const businessName = clean(b.businessName, 120);
    const website = clean(b.website, 300);
    const country = clean(b.country, 2).toUpperCase();
    if (!legalName) return { ok: false as const, status: 400, error: "Enter your legal name as it appears on your ID" };
    if (kind === "business" && !businessName) return { ok: false as const, status: 400, error: "Enter the registered business name" };
    if (website && !/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(website)) return { ok: false as const, status: 400, error: "Website must start with https://" };
    if (!/^[A-Z]{2}$/.test(country)) return { ok: false as const, status: 400, error: "Pick your country" };
    const id = `vr_${randomBytes(9).toString("base64url")}`;
    const files: { data: unknown; label: string }[] = [{ data: b.idDoc, label: "Government ID" }];
    if (kind === "business") files.push({ data: b.businessDoc, label: "Business registration" });
    const docs: VerificationRequest["docs"] = [];
    for (const f of files) {
      const saved = await this.saveDoc(id, f.data);
      if (!saved) {
        for (const d of docs) await this.deleteDoc(d.id);
        return { ok: false as const, status: 400, error: `${f.label}: upload a JPG, PNG or PDF under 8 MB` };
      }
      docs.push({ ...saved, label: f.label });
    }
    for (const o of open) await this.closeRequest(o, "rejected", "Replaced by a newer request", "system");
    const now = Date.now();
    const r: VerificationRequest = { id, userId: uid, kind, legalName, businessName, website, country, docs, status: this.feeWaived ? "pending" : "awaiting_payment", feeCents: this.feeWaived ? 0 : this.fee(kind), orderId: null, note: "", reviewedBy: null, reviewedAt: null, createdAt: now, updatedAt: now };
    await this.requests.put(r);
    return { ok: true as const, request: this.publicRequest(r), checkoutRef: r.status === "awaiting_payment" ? `verify:${kind}:${id}` : null };
  }

  async withdraw(uid: string) {
    const r = this.requests.where((x) => x.userId === uid && x.status === "awaiting_payment")[0];
    if (!r) return { ok: false as const, status: 404, error: "Nothing to withdraw" };
    await this.closeRequest(r, "rejected", "Withdrawn", uid);
    return { ok: true as const };
  }

  product(): ProductHandler {
    const parse = (ref: string) => {
      const m = ref.match(/^verify:(creator|business):(vr_[\w-]{6,40})$/);
      return m ? { kind: m[1] as AccountType, id: m[2] } : null;
    };
    return {
      manageUrl: "/creator",
      title: (ref) => `Open Lounge ${parse(ref)?.kind === "business" ? "business" : "creator"} verification`,
      quote: (uid, ref) => {
        const p = parse(ref);
        const r = p ? this.requests.get(p.id) : null;
        if (!this.enabled) return { ok: false, status: 503, error: "Verification isn't available yet" };
        if (!p || !r || r.userId !== uid || r.kind !== p.kind) return { ok: false, status: 404, error: "Request not found" };
        if (r.status !== "awaiting_payment") return { ok: false, status: 409, error: "This request is already paid" };
        return { ok: true, amountCents: r.feeCents, currency: "USD", title: `Open Lounge ${r.kind} verification` };
      },
      fulfil: async (o: OrderRow) => {
        const p = parse(o.packId);
        const r = p ? this.requests.get(p.id) : null;
        if (!r || r.status !== "awaiting_payment") return; // idempotent
        await this.requests.put({ ...r, status: "pending", orderId: o.id, updatedAt: Date.now() });
      },
      revoke: async (o: OrderRow) => {
        const p = parse(o.packId);
        const r = p ? this.requests.get(p.id) : null;
        if (!r) return;
        if (r.status === "approved") {
          await this.badges.remove(r.userId);
          await this.requests.put({ ...r, status: "revoked", note: "Payment refunded or reversed", updatedAt: Date.now() });
        } else if (r.status === "pending" || r.status === "awaiting_payment") await this.closeRequest(r, "rejected", "Payment refunded or reversed", "system");
      },
    };
  }

  queue() {
    return this.requests.where((r) => r.status === "pending").sort((a, b) => a.updatedAt - b.updatedAt);
  }
  async decide(by: string, id: unknown, approve: boolean, note: unknown) {
    const r = typeof id === "string" ? this.requests.get(id) : null;
    if (!r) return { ok: false as const, status: 404, error: "Request not found" };
    if (r.status !== "pending") return { ok: false as const, status: 409, error: "Only paid, pending requests can be decided" };
    const n = clean(note, 500);
    if (!approve && !n) return { ok: false as const, status: 400, error: "Add a reason for the applicant" };
    if (approve) await this.badges.put({ id: r.userId, verified: r.kind, since: Date.now(), requestId: r.id });
    await this.closeRequest(r, approve ? "approved" : "rejected", n, by);
    return { ok: true as const };
  }
  async revokeBadge(by: string, uid: unknown, note: unknown) {
    const b = typeof uid === "string" ? this.badges.get(uid) : null;
    if (!b) return { ok: false as const, status: 404, error: "Not verified" };
    await this.badges.remove(b.id);
    const r = this.requests.get(b.requestId);
    if (r) await this.requests.put({ ...r, status: "revoked", note: clean(note, 500) || "Revoked", reviewedBy: by, reviewedAt: Date.now(), updatedAt: Date.now() });
    return { ok: true as const };
  }
  private async closeRequest(r: VerificationRequest, status: VerificationRequest["status"], note: string, by: string) {
    for (const d of r.docs) await this.deleteDoc(d.id); // ID documents are never kept after a decision
    await this.requests.put({ ...r, status, note, docs: [], reviewedBy: by, reviewedAt: Date.now(), updatedAt: Date.now() });
  }

  private async saveDoc(reqId: string, data: unknown): Promise<{ id: string; mime: string } | null> {
    if (typeof data !== "string") return null;
    const m = data.match(/^data:(image\/(?:png|jpeg|jpg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    let buf: Buffer = Buffer.from(m[2], "base64");
    if (buf.length > 8 * 1024 * 1024) return null;
    let mime = m[1] === "image/jpg" ? "image/jpeg" : m[1];
    if (mime === "application/pdf") {
      if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
    } else {
      try {
        const sharp = (await import("sharp")).default;
        buf = await sharp(buf, { limitInputPixels: 60_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); // strips EXIF/GPS
        mime = "image/jpeg";
      } catch {
        return null;
      }
    }
    await fs.promises.mkdir(VERIFY_DOCS, { recursive: true, mode: 0o700 });
    const id = `${reqId}-${randomBytes(6).toString("hex")}${mime === "application/pdf" ? ".pdf" : ".jpg"}`;
    await fs.promises.writeFile(path.join(VERIFY_DOCS, id), buf, { mode: 0o600 });
    return { id, mime };
  }
  async readDoc(docId: string) {
    if (!/^vr_[\w-]{6,40}-[0-9a-f]{12}\.(jpg|pdf)$/.test(docId)) return null;
    const owner = this.requests.all().find((r) => r.docs.some((d) => d.id === docId));
    if (!owner) return null;
    try {
      return { buf: await fs.promises.readFile(path.join(VERIFY_DOCS, docId)), mime: docId.endsWith(".pdf") ? "application/pdf" : "image/jpeg" };
    } catch {
      return null;
    }
  }
  private async deleteDoc(docId: string) {
    await fs.promises.rm(path.join(VERIFY_DOCS, path.basename(docId)), { force: true }).catch(() => {});
  }

  // ---------- branding ----------
  async saveBranding(uid: string, b: Record<string, unknown>) {
    if (!this.enabled) return { ok: false as const, status: 503, error: "Creator accounts aren't available yet" };
    if (!this.isCreator(uid)) return { ok: false as const, status: 403, error: "Turn on your creator account first" };
    const cur = this.branding.get(uid);
    const slug = b.slug !== undefined ? clean(b.slug, 30).toLowerCase() : (cur?.slug ?? "");
    if (slug) {
      if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(slug)) return { ok: false as const, status: 400, error: "Links use 3–30 letters, numbers or dashes" };
      if (RESERVED.has(slug)) return { ok: false as const, status: 409, error: "That link is reserved" };
      const taken = this.branding.all().find((x) => x.slug === slug && x.id !== uid);
      if (taken) return { ok: false as const, status: 409, error: "That link is taken" };
    }
    const color = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toUpperCase() : d);
    const coHosts = Array.isArray(b.coHosts)
      ? [...new Set(b.coHosts.map((x) => clean(x, 80).replace(/^@/, "")).filter(Boolean))]
          .slice(0, 10)
          .map((h) => store.users.get(h)?.id ?? [...store.users.values()].find((u) => u.username?.toLowerCase() === h.toLowerCase())?.id)
      : (cur?.coHosts ?? []);
    if (coHosts.some((x) => !x)) return { ok: false as const, status: 400, error: "One of the co-hosts wasn't found" };
    const next: Branding = {
      id: uid,
      slug,
      displayName: b.displayName !== undefined ? clean(b.displayName, 60) : (cur?.displayName ?? ""),
      logo: cur?.logo ?? null,
      cover: cur?.cover ?? null,
      accent: color(b.accent, cur?.accent ?? "#10B981"),
      background: color(b.background, cur?.background ?? "#0B0B0D"),
      coHosts: (coHosts as string[]).filter((x) => x !== uid),
      updatedAt: Date.now(),
    };
    if (b.logoData === null) next.logo = null;
    else if (typeof b.logoData === "string") next.logo = (await this.saveImage(uid, "logo", b.logoData, 512, 512)) ?? next.logo;
    if (b.coverData === null) next.cover = null;
    else if (typeof b.coverData === "string") next.cover = (await this.saveImage(uid, "cover", b.coverData, 1600, 600)) ?? next.cover;
    await this.branding.put(next);
    return { ok: true as const, branding: next };
  }
  isCoHost(hostId: string, uid: string) {
    return this.enabled && !!this.branding.get(hostId)?.coHosts.includes(uid);
  }
  private async saveImage(uid: string, kind: string, dataUrl: string, w: number, h: number) {
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 6 * 1024 * 1024) return null;
    try {
      const sharp = (await import("sharp")).default;
      const out = await sharp(buf, { limitInputPixels: 40_000_000, animated: false }).rotate().resize({ width: w, height: h, fit: kind === "logo" ? "cover" : "cover" }).webp({ quality: 82 }).toBuffer();
      await fs.promises.mkdir(CREATOR_FILES, { recursive: true });
      const file = `${uid.replace(/[^\w-]/g, "")}-${kind}-${randomBytes(4).toString("hex")}.webp`;
      await fs.promises.writeFile(path.join(CREATOR_FILES, file), out);
      return `/creator-files/${file}`;
    } catch {
      return null;
    }
  }

  // ---------- series ----------
  async saveSeries(uid: string, b: Record<string, unknown>) {
    if (!this.enabled) return { ok: false as const, status: 503, error: "Creator accounts aren't available yet" };
    if (!this.isCreator(uid)) return { ok: false as const, status: 403, error: "Turn on your creator account first" };
    const cur = typeof b.id === "string" ? this.series.get(b.id) : null;
    if (cur && cur.hostId !== uid) return { ok: false as const, status: 404, error: "Series not found" };
    if (!cur && this.series.where((s) => s.hostId === uid).length >= 20) return { ok: false as const, status: 400, error: "Up to 20 series" };
    const title = clean(b.title, 80);
    const weekdays = Array.isArray(b.weekdays) ? [...new Set(b.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    const time = typeof b.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : "";
    let tz = clean(b.tz, 60) || "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      tz = "UTC";
    }
    if (!title || !weekdays.length || !time) return { ok: false as const, status: 400, error: "Series need a title, at least one day and a time" };
    const s: Series = { id: cur?.id ?? `ser_${randomBytes(6).toString("base64url")}`, hostId: uid, title, description: clean(b.description, 300), weekdays, time, tz, durationMin: Math.max(15, Math.min(600, Math.round(Number(b.durationMin) || 60))), active: b.active !== false, createdAt: cur?.createdAt ?? Date.now() };
    await this.series.put(s);
    return { ok: true as const, series: s };
  }
  async deleteSeries(uid: string, id: unknown) {
    const s = typeof id === "string" ? this.series.get(id) : null;
    if (!s || s.hostId !== uid) return { ok: false as const, status: 404, error: "Series not found" };
    await this.series.remove(s.id);
    return { ok: true as const };
  }
  /** next occurrences (UTC ms) across a host's active series */
  upcoming(hostId: string, now = Date.now(), limit = 6) {
    const out: { seriesId: string; title: string; at: number; durationMin: number }[] = [];
    for (const s of this.series.where((x) => x.hostId === hostId && x.active)) {
      for (let d = 0; d < 15; d++) {
        const at = zonedTime(now + d * 86_400_000, s.time, s.tz);
        if (at === null || at < now - s.durationMin * 60_000) continue;
        if (!s.weekdays.includes(weekdayIn(at, s.tz))) continue;
        out.push({ seriesId: s.id, title: s.title, at, durationMin: s.durationMin });
      }
    }
    return out.sort((a, b) => a.at - b.at).slice(0, limit);
  }

  /** public brand page data for /r/<slug> */
  page(slugRaw: unknown) {
    if (!this.enabled) return null;
    const slug = clean(slugRaw, 30).toLowerCase();
    const b = this.branding.all().find((x) => x.slug === slug);
    if (!b) return null;
    const host = store.users.get(b.id);
    if (!host) return null;
    const live = store.listRooms().find((r) => r.hostId === b.id) ?? null;
    return {
      branding: b,
      host: { id: host.id, name: host.name, username: host.username, verified: this.verifiedOf(host.id) },
      live: live ? { id: live.id, title: live.title, listeners: live.listenerCount + live.speakerCount } : null,
      upcoming: this.upcoming(b.id),
    };
  }
  brandingForHost(hostId: string) {
    if (!this.enabled) return null;
    const b = this.branding.get(hostId);
    return b ? { ...b, verified: this.verifiedOf(hostId) } : null;
  }

  // ---------- analytics ----------
  async sample(now = Date.now()) {
    const rooms = (store as unknown as { rooms: Map<string, { id: string; title: string; hostId: string; ended: boolean; private?: boolean; createdAt: number; participants: Map<string, { userId: string; role: string }> }> }).rooms;
    const seen = new Set<string>();
    for (const r of rooms.values()) {
      if (r.ended || r.private || !this.isCreator(r.hostId)) continue;
      seen.add(r.id);
      let l = this.live.get(r.id);
      const prev = this.sessions.get(r.id);
      if (!l) {
        l = { hostId: r.hostId, first: new Map(), last: new Map(), minutes: prev?.listenerMinutes ?? 0, peak: prev?.peak ?? 0, curve: prev?.curve ?? [], lastTick: now };
        this.live.set(r.id, l);
      }
      const listeners = [...r.participants.values()].filter((p) => p.userId !== r.hostId);
      const dtMin = Math.min(5, Math.max(0, (now - l.lastTick) / 60_000));
      l.minutes += listeners.length * (l.curve.length ? dtMin : 0);
      l.lastTick = now;
      for (const p of listeners) {
        if (!l.first.has(p.userId)) l.first.set(p.userId, now);
        l.last.set(p.userId, now);
      }
      l.peak = Math.max(l.peak, listeners.length);
      l.curve.push([Math.round((now - r.createdAt) / 60_000), listeners.length]);
      if (l.curve.length > 240) l.curve = l.curve.filter((_, i) => i % 2 === 0);
      await this.sessions.put(this.toSession(r.id, r.title, r.createdAt, null, l, prev));
    }
    for (const [id, l] of this.live) {
      if (seen.has(id)) continue;
      const prev = this.sessions.get(id);
      if (prev) await this.sessions.put(this.toSession(id, prev.title, prev.startedAt, now, l, prev));
      this.live.delete(id);
    }
    // follower snapshot per creator per day (refreshed hourly; new creators get today's row right away)
    const d = day(now);
    const creators = this.profiles.where((p) => p.enabled).map((p) => p.id);
    const missing = creators.filter((c) => !this.followerDays.get(`${c}|${d}`));
    const due = now - this.lastFollowerAt >= 3_600_000 ? creators : missing;
    if (due.length) {
      const counts = new Map<string, number>(due.map((c) => [c, 0]));
      for (const set of store.follows.values()) for (const c of due) if (set.has(c)) counts.set(c, counts.get(c)! + 1);
      for (const [uid, n] of counts) await this.followerDays.put({ id: `${uid}|${d}`, userId: uid, day: d, followers: n });
      if (due === creators) this.lastFollowerAt = now;
    }
  }
  private toSession(id: string, title: string, startedAt: number, endedAt: number | null, l: Live, prev: RoomSession | null): RoomSession {
    const lastSample = Math.max(0, ...l.last.values());
    const ret = (min: number) => {
      const eligible = [...l.first].filter(([, f]) => f <= lastSample - min * 60_000);
      if (!eligible.length) return 0;
      const kept = eligible.filter(([u, f]) => (l.last.get(u) ?? f) - f >= min * 60_000).length;
      return Math.round((kept / eligible.length) * 100) / 100;
    };
    return {
      id,
      hostId: l.hostId,
      title,
      startedAt,
      endedAt,
      peak: l.peak,
      uniqueListeners: Math.max(prev?.uniqueListeners ?? 0, l.first.size),
      listenerMinutes: Math.round(l.minutes * 10) / 10,
      curve: l.curve,
      retention: { m5: ret(5), m15: ret(15), m30: ret(30), m60: ret(60) },
      replays: prev?.replays ?? 0,
    };
  }
  /** replay hook for when room recordings exist */
  async countReplay(roomId: string) {
    const s = this.sessions.get(roomId);
    if (s) await this.sessions.put({ ...s, replays: s.replays + 1 });
  }

  analytics(uid: string, days = 30): CreatorAnalytics {
    const since = Date.now() - days * 86_400_000;
    const sessions = this.sessions.where((s) => s.hostId === uid && s.startedAt >= since).sort((a, b) => b.startedAt - a.startedAt);
    const listeners = sessions.reduce((n, s) => n + s.uniqueListeners, 0);
    const minutes = sessions.reduce((n, s) => n + s.listenerMinutes, 0);
    return {
      sessions,
      totals: { rooms: sessions.length, listeners, peak: Math.max(0, ...sessions.map((s) => s.peak)), listenerMinutes: Math.round(minutes), avgListenMin: listeners ? Math.round((minutes / listeners) * 10) / 10 : 0, replays: sessions.reduce((n, s) => n + s.replays, 0) },
      followers: this.followerDays.where((f) => f.userId === uid && f.day >= day(since)).sort((a, b) => a.day.localeCompare(b.day)).map((f) => ({ day: f.day, followers: f.followers })),
    };
  }
}

/** UTC ms for "HH:MM" on the calendar day of `ref` in zone `tz` */
export function zonedTime(ref: number, hhmm: string, tz: string): number | null {
  const [h, m] = hhmm.split(":").map(Number);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ref)).map((p) => [p.type, p.value]));
  const guess = Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, m);
  // shift by the zone offset at that moment (two passes handle DST edges)
  let t = guess;
  for (let i = 0; i < 2; i++) t = guess - offsetMin(t, tz) * 60_000;
  return Number.isFinite(t) ? t : null;
}
function offsetMin(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60_000) * 60_000) / 60_000;
}
export function weekdayIn(t: number, tz: string) {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(t));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

let instance: CreatorService | null = null;
export function creator(): CreatorService {
  if (!instance) instance = new CreatorService();
  return instance;
}
export function setCreatorService(c: CreatorService | null) {
  instance = c;
}
