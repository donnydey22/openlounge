# media-cache — self-hosted cache in front of the media origin

A second Railway service built from this repo, structured like the app/origin service (`openlounge`):

| | origin (`openlounge`) | cache (`media-cache`) |
|---|---|---|
| build | `Dockerfile` (repo root) | `media-cache/Dockerfile` |
| config | `railway.json` | `media-cache/railway.json` |
| entrypoint | `docker-entrypoint.sh` (root → prepares `$DATA_DIR`, drops privileges) | `media-cache/entrypoint.sh` (same) |
| volume | `/data` (`DATA_DIR`) — uploads, processed media | `/data` (`DATA_DIR`) — `cache/`, `cache-meta/tomb/` |
| liveness / readiness | `/healthz` / `/readyz` (deploy gate) | `/healthz` / `/readyz` (deploy gate) |
| public port | `PORT` → https://openlounge.app | `PORT`=8080 → Railway domain (later `cdn.openlounge.app`) |
| private port | `MEDIA_INTERNAL_PORT`=8081 (`/media/*`, raw playlists) | `MEDIA_CACHE_INTERNAL_PORT`=8081 (`/_purge`) |
| signing secret | `MEDIA_SIGNING_SECRET` | `MEDIA_SIGNING_SECRET` (Railway reference to the app's) |
| deploy | `railway up $D --path-as-root` under the DEPLOY_POLICY flock | `railway up $D/media-cache --path-as-root --service media-cache` under the same flock |

Contract: `/workspace/media/CACHE_CONTRACT.md` (v1). This service implements the cache half verbatim.

```
browser ──https──▶ media-cache (nginx, Railway edge TLS)            openlounge (Node)
                   │ verify HMAC token (njs) on EVERY request          ▲
                   │ HIT  → serve from /data/cache (+ playlist rewrite) │
                   │ MISS → http://openlounge.railway.internal:8081 ────┘  (private network, IPv6, token forwarded,
                   │        one fetch per object (proxy_cache_lock)        origin re-checks access)
                   ◀── POST /_purge {"prefixes":["/media/<id>/"]} on :8081 (Bearer MEDIA_CACHE_PURGE_SECRET)
```

## Why nginx (not Varnish)
- Signed-link check on hits needs code at the edge: nginx's njs does HMAC-SHA256 natively (Varnish would need a vmod
  build or inline C), and njs also does the per-viewer playlist rewrite as a body filter on cached responses.
- Disk-backed cache that survives restarts on a Railway volume (Varnish's file storage is not persistent).
- `slice` module for byte-range caching of the MP4 fallback; `proxy_cache_lock` + `use_stale updating/error` +
  `background_update` for stampede protection; `upstream … resolve` re-resolves the private hostname.
- Tiny footprint (~10–30 MB RAM) on the official `nginx:1.31-alpine` image, which ships njs.

## Behaviour
- Cache key: path only (`$uri`); `exp`, `p`, `u`, `t` are never part of it. Origin `Cache-Control` decides TTL
  (segments/init/posters/thumbs/mp4/m4a/docs 1 year immutable; processing rendition playlist 5 s, processing master 10 s,
  then 1 year). `no-store`/`private` responses are never stored; non-2xx are never stored (no validity configured).
- Token rule (contract §3): `p` must be `/media/<32 hex>/v<rev>/`, the request path must start with it, `exp` in the
  future, `t = base64url(HMAC-SHA256(secret, p|exp|u))` (constant-time compare). Otherwise **403 `no-store`** before
  the cache is consulted. The access log records the path and `auth=` reason, never the query string.
- Playlists: the cached copy is the origin's raw, token-free playlist; each response appends the requesting viewer's
  own `exp&p&u&t` to every URI line and every `URI="…"` attribute; gzip + `Vary: Accept-Encoding`.
- Ranges: segments/images are cached whole and ranges served from the stored copy; `full.mp4` is cached in 1 MiB slices.
- Purge: writes a tombstone (`/data/cache-meta/tomb/<id>`) so the item bypasses the cache forever (the origin answers),
  and deletes every cached file whose key starts with the prefix.
- `X-Cache-Status`: MISS / HIT / STALE / UPDATING / EXPIRED / REVALIDATED / BYPASS, `DENIED` for rejected tokens.

## Env
`PORT` (8080) · `DATA_DIR` (/data) · `MEDIA_ORIGIN_URL` (http://openlounge.railway.internal:8081) ·
`MEDIA_SIGNING_SECRET` (required, ≥16 chars) · `MEDIA_CACHE_PURGE_SECRET` · `MEDIA_CACHE_INTERNAL_PORT` (8081) ·
`MEDIA_CACHE_MAX_SIZE` (400m — the volume is 0.5 GB on the current plan) · `MEDIA_CACHE_MIN_FREE` (48m) ·
`MEDIA_CACHE_INACTIVE` (30d) · `MEDIA_CACHE_WORKERS` (2) · `READYZ_REQUIRE_ORIGIN` (unset: an origin outage doesn't block a cache deploy).

On the app: `MEDIA_CACHE_PURGE_URL=http://media-cache.railway.internal:8081/_purge`,
`MEDIA_CACHE_PURGE_SECRET=${{media-cache.MEDIA_CACHE_PURGE_SECRET}}`. The switch `MEDIA_CDN_BASE` stays unset until go.

## Tests
```
export MEDIA_SIGNING_SECRET=… MEDIA_CACHE_PURGE_SECRET=…   # any test values
media-cache/test/run-local.sh                              # nginx (same entrypoint/template) + contract mock origin
CACHE_DIR=/tmp/media-cache-test/data/cache NGINX_LOG=/tmp/media-cache-test/nginx.log node media-cache/test/cache.test.mjs
node media-cache/test/playback.test.mjs                    # hls.js playback in Chrome, Firefox, WebKit through the cache
```
Fixture (`test/.fixture`, git-ignored): `media-cache/test/make-fixture.sh` (ffmpeg).

## Honest limits
Single region (same Railway region as the origin). It offloads the origin and makes repeat loads fast, but it does
not move bytes closer to far-away viewers — that needs more regions/replicas of this service (same image, its own
volume) or a multi-PoP network.
