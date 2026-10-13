# Operations: env vars, secrets, backups, health

## Health
- `GET /healthz` — liveness (process up). Docker `HEALTHCHECK` uses it.
- `GET /readyz` — readiness: Postgres `SELECT 1` (2 s timeout) + LiveKit HTTP reachability (2 s, cached 10 s);
  503 when the DB is down or the process is draining. Railway healthcheck uses it.
- `GET /api/health` — unchanged (legacy; storage + schema info).
- `GET /metrics` — Prometheus text; requires `Authorization: Bearer $METRICS_TOKEN` (404 in production without it).

## Graceful shutdown (SIGTERM)
stop accepting → `/readyz` 503 → every WebSocket closed with **1012** (clients reconnect with jittered backoff and
catch up via `dm:since`) → in-flight HTTP finishes (≤ ½ of `SHUTDOWN_TIMEOUT_MS`, default 15 s) → final store flush →
pg pool closed → exit 0. `drainingSeconds: 20` in railway.json gives it the time.

## AUTH_SECRET (access-token HMAC key) and rotation
Precedence: `AUTH_SECRET` env → key stored in Postgres `openlounge_meta.auth_secret` (current production) → ephemeral.
Tokens carry a key id (`ol1.<sid>.<exp>.<sig>.<kid>`); pre-change 4-part tokens verify against every known key.
- **Cut-over from the DB key** (planned): set `AUTH_SECRET=$(cat ~/.secrets/openlounge_auth_secret)` on Railway.
  The DB key stays a *verification* key automatically, so no one is signed out. After ≥ 1 h (access TTL) optionally set
  `AUTH_SECRET_ACCEPT_DB=0`.
- **Rotation**: move the current value to `AUTH_SECRET_PREVIOUS` (comma-separated), set a new `AUTH_SECRET`, redeploy;
  remove the old value from `AUTH_SECRET_PREVIOUS` after ≥ 1 h. Refresh tokens are opaque (hash in DB) and unaffected,
  so even a hard rotation only costs clients one silent refresh.

## Backups
Production backup design and rollout/revert instructions: [Railway-private encrypted PostgreSQL backups](postgres-backups.md).

- The dedicated Railway Cron service connects only through `postgres.railway.internal` with its read-only
  `openlounge_backup_ro` role. It encrypts each custom dump and row-count inventory before SFTP to the existing
  LUKS-protected media-host volume; no public Railway PostgreSQL TCP proxy is enabled or required.
- The media host receives ciphertext only, validates a restore and application-table row counts in a temporary
  loopback-only PostgreSQL cluster, and retains 7 daily plus 4 weekly verified receipt triplets.
- `npm run db:backup` remains a **manual developer helper** requiring an explicitly provided private `DATABASE_URL`;
  it is not the production schedule and does not read `DATABASE_PUBLIC_URL`.

## Environment variables (new in this branch; all optional)
| Var | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | (DB key) | signing key; value prepared in `~/.secrets/openlounge_auth_secret` |
| `AUTH_SECRET_PREVIOUS` | — | old keys accepted for verification during rotation |
| `AUTH_SECRET_ACCEPT_DB` | `1` | `0` = stop accepting DB-key tokens once AUTH_SECRET is set |
| `CSP_REPORT_ONLY` | `0` | `1` = send `Content-Security-Policy-Report-Only` instead of enforcing |
| `CSP` | on | `0` disables CSP entirely (emergency) |
| `CSP_REPORT_URI` | — | adds `report-uri` |
| `CSP_EXTRA_CONNECT` | — | extra connect-src origins (space/comma separated) |
| `PUBLIC_HOST` | `openlounge.app` | host used for the explicit `wss://` connect-src entry |
| `HSTS` | on in prod | `0` disables HSTS |
| `CANONICAL_HOST` | `openlounge.app` | www → apex redirect target |
| `METRICS_TOKEN` | — | enables `/metrics` in production |
| `READYZ_REQUIRE_LIVEKIT` | `0` | `1` = LiveKit outage fails readiness |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | hard cap for graceful shutdown |
| `DATABASE_POOL_MAX` / `DATABASE_IDLE_TIMEOUT_MS` / `DATABASE_CONNECT_TIMEOUT_MS` | 5 / 30000 / 10000 | pool |
| `DATABASE_STATEMENT_TIMEOUT_MS` / `DATABASE_IDLE_TX_TIMEOUT_MS` / `DATABASE_QUERY_TIMEOUT_MS` | 15000 / 30000 / 20000 | server/client query guards (migrations run with statement_timeout 0) |
| `WS_RATE_PER_SEC` / `WS_RATE_BURST` / `WS_MAX_STRIKES` | 20 / 60 / 50 | per-socket inbound rate limit; strikes → close 1008 |
| `WS_SMALL_FRAME_BYTES` / `WS_MAX_BUFFERED_BYTES` | 16384 / 1000000 | non-photo frame cap; slow-consumer cap (close 1013) |
| `WS_REVALIDATE_MS` | `60000` | re-check sessions of open sockets |
| `RL_AUTH_PER_MIN` / `RL_LIVEKIT_PER_MIN` / `RL_API_PER_MIN` | 30 / 60 / 300 | per-IP HTTP limits |
| `HTTP_MAX_BODY_BYTES` | `16384` | JSON body cap (413) |
| `LOG_LEVEL` / `LOG_FORMAT` | info / json | `pretty` for dev |

## www.openlounge.app (flag — needs Railway paid plan for a 2nd custom domain)
The server already answers any request whose Host is `www.openlounge.app` with **308 → https://openlounge.app/<path>**
(`wwwRedirect` in `server/httpsec.ts`). Once the plan allows it: Railway → openlounge → Settings → Networking → add
custom domain `www.openlounge.app`, add the CNAME it shows at the DNS host, wait for the certificate. No code change.
HSTS `includeSubDomains` already covers `www` (only send `preload` after www has a valid cert for ≥ a few weeks).
