# Auto-deploy from `main` (prepared — NOT enabled)

Today deploys are manual (`railway up` / dashboard). The service already shows `repo: donnydey22/openlounge`, so the
GitHub source is connected; what's missing is the gate. Steps for when we turn it on:

1. **Merge the `hardening` branch first** — it adds `/readyz` and the `railway.json` deploy gate:
   `healthcheckPath: /readyz`, `healthcheckTimeout: 120`, `drainingSeconds: 20`, `overlapSeconds: 10`, `numReplicas: 1`.
   Railway only switches traffic to a new deployment after `/readyz` returns 200 (DB reachable, migrations applied,
   not draining). A failing deploy never takes traffic; the old one keeps serving.
2. **Add CI checks on GitHub** (branch protection on `main`): `npm ci && npm run typecheck && npm run build &&
   npm run test:hardening` (needs a Postgres service container; set `TEST_DATABASE_URL`). Require them to pass.
3. Railway dashboard → service `openlounge` → Settings → Source:
   - Branch: `main`; enable **"Wait for CI"** (deploys only after GitHub checks pass).
   - Keep the `watchPatterns` in `railway.json` (docs-only commits don't redeploy).
4. Railway → Settings → Deploy: confirm the healthcheck path shows `/readyz` (config-as-code wins over the dashboard).
5. Roll back = Railway dashboard → Deployments → previous → **Redeploy** (or `railway down` removes the latest).
   Migrations are forward-only and additive (`IF NOT EXISTS`), so the previous build runs against the newer schema.

Notes
- `railway.json` (config-as-code) is deprecated by Railway in favour of `.railway/railway.ts`; existing files keep working
  until **2026-12-01**. Run `railway config migrate` before then (not done here: it changes how config is applied).
- With `overlapSeconds: 10`, two instances briefly run at once. That is already safe: migrations take an advisory lock,
  sessions created on the new instance are found via `findSession` fallback, WebSockets on the old one get close 1012
  and reconnect to the new one.
- `READYZ_REQUIRE_LIVEKIT=1` makes LiveKit reachability part of the gate. Default off so a LiveKit outage can't block
  an app deploy (rooms/chat/DMs work without audio); `/readyz` still reports `livekit.ok`.
