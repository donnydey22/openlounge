// Registry shared by the monetization modules (no imports of the modules themselves, so they can register at load
// time without import cycles).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Badges } from "../../src/lib/premium/types";

type Handler = (ctx: Ctx) => Promise<boolean | void>;
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: string;
  qs: URLSearchParams;
  method: string;
  uid: () => Promise<string | null>;
  body: () => Promise<Record<string, unknown>>;
  admin: () => Promise<string | null>;
  wrapper: boolean;
}
export const handlers: { prefix: string; fn: Handler }[] = [];
/** modules register their route prefix + handler (return false/undefined = not handled → 404) */
export function mount(prefix: string, fn: Handler) {
  if (!handlers.some((h) => h.prefix === prefix)) handlers.push({ prefix, fn });
}
/** badge providers (premium, verified creator/business) merged by GET /api/badges */
const badgeProviders: ((uid: string) => Partial<Badges>)[] = [];
export function provideBadges(fn: (uid: string) => Partial<Badges>) {
  badgeProviders.push(fn);
}
export function badgesOf(uid: string): Badges {
  return Object.assign({}, ...badgeProviders.map((f) => f(uid)));
}

export const inits: (() => Promise<void>)[] = [];
export function onInit(fn: () => Promise<void>) {
  inits.push(fn);
}
