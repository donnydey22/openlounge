// Conditional GET for immutable media files: strong ETag (size + mtime) + Last-Modified, 304 on a match.
// Media files never change in place (new uploads get new ids), so a revalidation after max-age costs headers only.
import type { IncomingMessage } from "node:http";
import type { Stats } from "node:fs";

export function fileEtag(stat: Pick<Stats, "size" | "mtimeMs">): string {
  return `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
}

/** Adds validators to headers; true when the request's If-None-Match / If-Modified-Since says the client copy is current. */
export function applyValidators(req: IncomingMessage, stat: Pick<Stats, "size" | "mtimeMs" | "mtime">, headers: Record<string, string>): boolean {
  const etag = fileEtag(stat);
  headers.ETag = etag;
  headers["Last-Modified"] = stat.mtime.toUTCString();
  const inm = req.headers["if-none-match"];
  if (typeof inm === "string" && inm.length) return inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*");
  const ims = Date.parse(String(req.headers["if-modified-since"] ?? ""));
  return Number.isFinite(ims) && Math.floor(stat.mtimeMs / 1000) <= Math.floor(ims / 1000);
}

/** Headers allowed on a 304 (no body / length / type). */
export function notModifiedHeaders(h: Record<string, string>): Record<string, string> {
  const keep = ["ETag", "Last-Modified", "Cache-Control", "Vary", "Access-Control-Allow-Origin", "Cross-Origin-Resource-Policy", "Pragma"];
  return Object.fromEntries(Object.entries(h).filter(([k]) => keep.includes(k)));
}
