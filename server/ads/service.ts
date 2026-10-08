// Sponsored rooms + highlighted ads (flag ADS_ENABLED, off by default).
//  - Placements: featured slot at the top of the hallway, and in Explore; always labelled "Sponsored".
//  - Booking & scheduling in the admin (advertiser, contact, price/reference, start/end, weight, frequency cap).
//  - Review queue: draft → pending_review → approved | rejected; only approved, in-schedule campaigns are served.
//  - Report: aggregate daily counters only (impressions, clicks, joins) per campaign/placement. No per-person rows,
//    no third-party SDKs, no cookies; the frequency cap lives in memory for the day.
// In-chat sponsored messages (b93a09c6, /sp/*) are a separate store with the same admin hub (/admin/ads).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Collection, flag, q } from "../monet/db";
import { DATA_DIR } from "../persistence";
import { store } from "../store";
import { AD_PLACEMENTS, type AdPlacement, type AdStatsRow, type AdView, type Campaign, type CampaignStatus } from "../../src/lib/ads/types";

export const AD_DIR = path.resolve(process.env.AD_FILES_DIR || path.join(DATA_DIR, "ad-files"));
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim()
    .slice(0, max);

type Stat = { impressions: number; clicks: number; joins: number };

export class AdsService {
  campaigns = new Collection<Campaign>("ad_campaigns", ["status"]);
  /** pending counter deltas, flushed every 30 s (one upsert per key) */
  private pending = new Map<string, Stat>();
  /** memory-only frequency cap + event dedupe for today: "<day>|<uid>|<cmp>" → seen count, "<day>|<uid>|<cmp>|<type>" */
  private seen = new Map<string, number>();
  private events = new Set<string>();
  private seenDay = day();
  /** memory fallback for stats (no DATABASE_URL: dev/tests) */
  memStats = new Map<string, AdStatsRow>();
  private timer: NodeJS.Timeout | null = null;
  private ready = false;
  constructor(private env: Record<string, string | undefined> = process.env) {}

  get enabled() {
    return flag(this.env.ADS_ENABLED);
  }

  async init() {
    if (this.ready) return;
    await this.campaigns.load();
    this.ready = true;
    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), 30_000);
      this.timer.unref?.();
    }
  }

  // ---------- serving ----------
  private live(c: Campaign, now: number) {
    return c.status === "approved" && c.startsAt <= now && (!c.endsAt || c.endsAt > now);
  }
  private roomFor(c: Campaign) {
    if (c.kind !== "room" || !c.hostId) return null;
    const r = store.listRooms().find((x) => x.hostId === c.hostId);
    return r ? { id: r.id, title: r.title, hostName: r.hostName, speakerCount: r.speakerCount, listenerCount: r.listenerCount, speakers: r.speakers } : null;
  }
  private rollDay() {
    const d = day();
    if (d !== this.seenDay) {
      this.seenDay = d;
      this.seen.clear();
      this.events.clear();
    }
  }

  /** at most one sponsored item per view; respects schedule, review, placement and the per-person daily cap */
  slot(userId: string, placementRaw: unknown, now = Date.now()): AdView | null {
    if (!this.enabled) return null;
    const placement = AD_PLACEMENTS.find((p) => p === placementRaw);
    if (!placement) return null;
    this.rollDay();
    const eligible = this.campaigns
      .where((c) => this.live(c, now) && c.placements.includes(placement) && (this.seen.get(`${this.seenDay}|${userId}|${c.id}`) ?? 0) < c.capPerDay)
      .map((c) => ({ c, room: this.roomFor(c) }))
      .filter(({ c, room }) => room || (c.title && c.ctaUrl)); // room campaigns need the host live, or a fallback card
    if (!eligible.length) return null;
    // weighted pick, stable for a person within 10 minutes (no profiling: hash of user + window only)
    const total = eligible.reduce((s, e) => s + Math.max(1, e.c.weight), 0);
    let h = 0;
    for (const ch of `${userId}|${Math.floor(now / 600_000)}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let pick = h % total;
    const chosen = eligible.find((e) => (pick -= Math.max(1, e.c.weight)) < 0) ?? eligible[0];
    const key = `${this.seenDay}|${userId}|${chosen.c.id}`;
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
    this.bump(chosen.c.id, placement, "impressions");
    const c = chosen.c;
    return { id: c.id, placement, advertiser: c.advertiser, kind: chosen.room ? "room" : "card", title: c.title, body: c.body, image: c.image, ctaLabel: c.ctaLabel, ctaUrl: c.ctaUrl, room: chosen.room };
  }

  /** click / join from a served card; counted once per person per campaign per day */
  event(userId: string, id: unknown, placementRaw: unknown, typeRaw: unknown) {
    if (!this.enabled) return false;
    const c = typeof id === "string" ? this.campaigns.get(id) : null;
    const placement = AD_PLACEMENTS.find((p) => p === placementRaw);
    const type = typeRaw === "click" ? "clicks" : typeRaw === "join" ? "joins" : null;
    if (!c || !placement || !type || !c.placements.includes(placement)) return false;
    this.rollDay();
    const k = `${this.seenDay}|${userId}|${c.id}|${type}`;
    if (this.events.has(k)) return true;
    if (!this.seen.has(`${this.seenDay}|${userId}|${c.id}`)) return false; // never served to them today
    this.events.add(k);
    this.bump(c.id, placement, type);
    return true;
  }

  private bump(id: string, placement: AdPlacement, k: keyof Stat) {
    const key = `${day()}|${id}|${placement}`;
    const s = this.pending.get(key) ?? { impressions: 0, clicks: 0, joins: 0 };
    s[k]++;
    this.pending.set(key, s);
  }

  async flush() {
    if (!this.pending.size) return;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [key, s] of batch) {
      const [d, id, placement] = key.split("|");
      const m = this.memStats.get(key) ?? { day: d, campaignId: id, placement: placement as AdPlacement, impressions: 0, clicks: 0, joins: 0 };
      m.impressions += s.impressions;
      m.clicks += s.clicks;
      m.joins += s.joins;
      this.memStats.set(key, m);
      try {
        await q(
          `INSERT INTO ad_stats_daily (day, campaign_id, placement, impressions, clicks, joins) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (day, campaign_id, placement) DO UPDATE SET impressions = ad_stats_daily.impressions + EXCLUDED.impressions,
           clicks = ad_stats_daily.clicks + EXCLUDED.clicks, joins = ad_stats_daily.joins + EXCLUDED.joins`,
          [d, id, placement, s.impressions, s.clicks, s.joins],
        );
      } catch (err) {
        console.warn("[ads] stats flush failed", (err as Error).message);
      }
    }
  }

  async report(from: string, to: string): Promise<AdStatsRow[]> {
    await this.flush();
    const rows = await q<{ day: string; campaign_id: string; placement: AdPlacement; impressions: string; clicks: string; joins: string }>(
      "SELECT day, campaign_id, placement, impressions, clicks, joins FROM ad_stats_daily WHERE day >= $1 AND day <= $2 ORDER BY day, campaign_id, placement",
      [from, to],
    );
    if (rows.length || !this.memStats.size) return rows.map((r) => ({ day: r.day, campaignId: r.campaign_id, placement: r.placement, impressions: +r.impressions, clicks: +r.clicks, joins: +r.joins }));
    return [...this.memStats.values()].filter((r) => r.day >= from && r.day <= to).sort((a, b) => a.day.localeCompare(b.day) || a.campaignId.localeCompare(b.campaignId));
  }

  async reportCsv(from: string, to: string) {
    const rows = await this.report(from, to);
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = ["day,campaign_id,advertiser,title,placement,impressions,clicks,joins,ctr"];
    for (const r of rows) {
      const c = this.campaigns.get(r.campaignId);
      const ctr = r.impressions ? (((r.clicks + r.joins) / r.impressions) * 100).toFixed(2) + "%" : "";
      lines.push([r.day, r.campaignId, esc(c?.advertiser ?? ""), esc(c?.title ?? ""), r.placement, r.impressions, r.clicks, r.joins, ctr].join(","));
    }
    return lines.join("\n") + "\n";
  }

  // ---------- admin: booking, scheduling, review ----------
  validate(input: Record<string, unknown>, cur: Campaign | null): { ok: true; v: Partial<Campaign> } | { ok: false; error: string } {
    const v: Partial<Campaign> = {};
    const has = (k: string) => input[k] !== undefined || !cur;
    if (has("advertiser")) {
      v.advertiser = clean(input.advertiser, 60);
      if (!v.advertiser) return { ok: false, error: "Advertiser is required" };
    }
    if (has("contact")) v.contact = clean(input.contact, 200);
    if (has("kind")) v.kind = input.kind === "room" ? "room" : "card";
    if (has("placements")) {
      const p = (Array.isArray(input.placements) ? input.placements : ["hallway"]).filter((x): x is AdPlacement => AD_PLACEMENTS.includes(x as AdPlacement));
      if (!p.length) return { ok: false, error: "Pick at least one placement" };
      v.placements = [...new Set(p)];
    }
    if (has("hostId")) {
      const h = clean(input.hostId, 80).replace(/^@/, "");
      if (h) {
        const u = store.users.get(h) ?? [...store.users.values()].find((x) => x.username?.toLowerCase() === h.toLowerCase());
        if (!u) return { ok: false, error: "No account with that id or @username" };
        v.hostId = u.id;
      } else v.hostId = null;
    }
    if (has("title")) v.title = clean(input.title, 80);
    if (has("body")) v.body = clean(input.body, 240);
    if (has("ctaLabel")) v.ctaLabel = clean(input.ctaLabel, 24) || "Learn more";
    if (has("ctaUrl")) {
      const raw = clean(input.ctaUrl, 2048);
      if (raw) {
        let u: URL;
        try {
          u = new URL(raw);
        } catch {
          return { ok: false, error: "Link must be a full https:// address" };
        }
        if (u.protocol !== "https:" || u.username || u.password) return { ok: false, error: "Link must be a plain https:// address" };
        v.ctaUrl = u.toString();
      } else v.ctaUrl = "";
    }
    if (has("startsAt")) v.startsAt = Number(input.startsAt) > 0 ? Math.round(Number(input.startsAt)) : Date.now();
    if (has("endsAt")) v.endsAt = Number(input.endsAt) > 0 ? Math.round(Number(input.endsAt)) : null;
    if (has("capPerDay")) v.capPerDay = Math.max(1, Math.min(50, Math.round(Number(input.capPerDay) || 3)));
    if (has("weight")) v.weight = Math.max(1, Math.min(100, Math.round(Number(input.weight) || 1)));
    if (input.booking !== undefined || !cur) {
      const b = (input.booking ?? {}) as Record<string, unknown>;
      const price = Number(b.priceCents);
      v.booking = { priceCents: Number.isInteger(price) && price >= 0 ? price : null, reference: clean(b.reference, 80), notes: clean(b.notes, 1000) };
    }
    const m = { ...cur, ...v } as Campaign;
    if (m.endsAt && m.endsAt <= m.startsAt) return { ok: false, error: "End must be after start" };
    if (m.kind === "room" && !m.hostId) return { ok: false, error: "Sponsored rooms need the host's @username" };
    if (m.kind === "card" && (!m.title || !m.ctaUrl)) return { ok: false, error: "Ad cards need a title and a link" };
    if (m.ctaUrl && !m.title) return { ok: false, error: "Add a title for the link" };
    return { ok: true, v };
  }

  async create(by: string, input: Record<string, unknown>) {
    const r = this.validate(input, null);
    if (!r.ok) return { ok: false as const, status: 400, error: r.error };
    const now = Date.now();
    const c: Campaign = {
      id: `cmp_${randomBytes(8).toString("base64url")}`,
      advertiser: "",
      contact: "",
      kind: "card",
      placements: ["hallway"],
      hostId: null,
      title: "",
      body: "",
      image: null,
      ctaLabel: "Learn more",
      ctaUrl: "",
      startsAt: now,
      endsAt: null,
      capPerDay: 3,
      weight: 1,
      booking: { priceCents: null, reference: "", notes: "" },
      ...r.v,
      status: "draft",
      review: null,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
    };
    if (typeof input.imageData === "string") c.image = await this.saveImage(c.id, input.imageData);
    await this.campaigns.put(c);
    return { ok: true as const, campaign: c };
  }

  /** edits send an approved/rejected campaign back to review (the reviewed version is what goes live) */
  async update(by: string, id: unknown, input: Record<string, unknown>) {
    const cur = typeof id === "string" ? this.campaigns.get(id) : null;
    if (!cur) return { ok: false as const, status: 404, error: "Campaign not found" };
    const r = this.validate(input, cur);
    if (!r.ok) return { ok: false as const, status: 400, error: r.error };
    const next: Campaign = { ...cur, ...r.v, updatedAt: Date.now() };
    if (typeof input.imageData === "string") next.image = await this.saveImage(cur.id, input.imageData);
    if (input.imageData === null) next.image = null;
    const contentChanged = ["kind", "placements", "hostId", "title", "body", "ctaLabel", "ctaUrl"].some((k) => JSON.stringify(next[k as keyof Campaign]) !== JSON.stringify(cur[k as keyof Campaign])) || next.image !== cur.image;
    if (contentChanged && (cur.status === "approved" || cur.status === "paused" || cur.status === "rejected")) {
      next.status = "pending_review";
      next.review = null;
    }
    await this.campaigns.put(next);
    return { ok: true as const, campaign: next };
  }

  async transition(by: string, id: unknown, action: unknown, note: unknown) {
    const c = typeof id === "string" ? this.campaigns.get(id) : null;
    if (!c) return { ok: false as const, status: 404, error: "Campaign not found" };
    const moves: Record<string, [CampaignStatus[], CampaignStatus]> = {
      submit: [["draft", "rejected"], "pending_review"],
      approve: [["pending_review"], "approved"],
      reject: [["pending_review", "approved", "paused"], "rejected"],
      pause: [["approved"], "paused"],
      resume: [["paused"], "approved"],
      withdraw: [["pending_review"], "draft"],
    };
    const m = typeof action === "string" ? moves[action] : null;
    if (!m) return { ok: false as const, status: 400, error: "Unknown action" };
    if (!m[0].includes(c.status)) return { ok: false as const, status: 409, error: `Can't ${action} a campaign that is ${c.status.replace("_", " ")}` };
    const next: Campaign = { ...c, status: m[1], updatedAt: Date.now() };
    if (action === "approve" || action === "reject") next.review = { by, at: Date.now(), note: clean(note, 500) };
    if (action === "reject" && !next.review?.note) return { ok: false as const, status: 400, error: "Add a note for the advertiser" };
    await this.campaigns.put(next);
    return { ok: true as const, campaign: next };
  }

  async remove(id: unknown) {
    const c = typeof id === "string" ? this.campaigns.get(id) : null;
    if (!c) return { ok: false as const, status: 404, error: "Campaign not found" };
    if (c.status === "approved") return { ok: false as const, status: 409, error: "Pause it first" };
    await this.campaigns.remove(c.id);
    if (c.image) fs.promises.rm(path.join(AD_DIR, path.basename(c.image)), { force: true }).catch(() => {});
    return { ok: true as const };
  }

  list() {
    return this.campaigns.all().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** re-encode uploads with sharp (strips metadata, no SVG), ≤1200 px JPEG on the volume */
  async saveImage(id: string, dataUrl: string): Promise<string | null> {
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 4 * 1024 * 1024) return null;
    try {
      const sharp = (await import("sharp")).default;
      const out = await sharp(buf, { limitInputPixels: 40_000_000, animated: false }).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).flatten({ background: "#18181b" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      await fs.promises.mkdir(AD_DIR, { recursive: true });
      const file = `${id}-${randomBytes(4).toString("hex")}.jpg`;
      await fs.promises.writeFile(path.join(AD_DIR, file), out);
      return `/ad-files/${file}`;
    } catch {
      return null;
    }
  }
}

let instance: AdsService | null = null;
export function ads(): AdsService {
  if (!instance) instance = new AdsService();
  return instance;
}
export function setAdsService(a: AdsService | null) {
  instance = a;
}
