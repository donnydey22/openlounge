# 🎙️ Open Lounge: a Clubhouse-style audio rooms MVP

Live audio rooms with a stage, raised hands and host controls. Also includes Clubhouse-style phone sign-up, in-room chat, 1:1 DMs and light/dark themes.

- **App:** Next.js 16 (App Router, React 19, Tailwind v4) running inside one custom Node server (`server/index.ts`).
- **Realtime:** raw WebSockets: [`ws`](https://github.com/websockets/ws) on the server and the browser's built-in `WebSocket` on the client. **No Socket.IO.**
- **Audio:** [LiveKit](https://livekit.io) SFU, via LiveKit Cloud in production. The app server issues join tokens and controls publish permissions.
- **Storage:** Postgres when `DATABASE_URL` is set (Railway Postgres in production); otherwise a local-dev JSON file (`data/db.json`). Uploaded avatars are files in `DATA_DIR/avatars/`. See [Storage](#storage).

| Dark | Light | Desktop |
|---|---|---|
| ![](docs/screenshots/dark-03-room-chat.png) | ![](docs/screenshots/light-02-room-chat.png) | ![](docs/screenshots/desktop-dark-room.png) |
| ![](docs/screenshots/auth-dark-03-code.png) | ![](docs/screenshots/auth-light-04-username.png) | ![](docs/screenshots/desktop-light-room.png) |

More screenshots are in [`docs/screenshots/`](docs/screenshots): sign-up steps, hallway, DMs, profile, settings, and LiveKit connected/speaker.

---

## Quick start (local)

```bash
npm install
npm run dev            # http://localhost:3000
```

1. Open the app, tap **Get your username 👋** and enter any phone number.
2. **Demo OTP:** no SMS is sent. The code appears on screen (tap to fill), and `000000` always works in demo mode.
3. Choose a name, username, photo or color, bio, interests and people to follow. Then you land in the hallway.

**Without LiveKit credentials** everything still works (rooms, stage, hands, chat, DMs), except that nobody hears anything. Rooms show *"🔇 Live audio is off: this server has no LiveKit credentials"*.

### Local audio (optional)

Use either LiveKit Cloud or a local LiveKit server:

```bash
# Option A: LiveKit Cloud project (see "Deploy" below)
LIVEKIT_URL=wss://<project>.livekit.cloud LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... npm run dev

# Option B: local SFU (https://docs.livekit.io/home/self-hosting/local/)
livekit-server --dev   # uses devkey / secret on ws://localhost:7880
LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm run dev
```

Browsers only expose the microphone on **https** or **localhost**.

### Several people on one machine

Sessions are stored per tab (sessionStorage, with localStorage as the fallback for new tabs), so each tab or incognito window can be a different account. Sign up with a different phone number in each.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server (Next + WebSockets + API on one port) |
| `npm run build` / `npm start` | Production build / start (`NODE_ENV=production`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Protocol smoke test against a running server: OTP sign-up, returning login, session resume, room chat, DMs, LiveKit token endpoint, end room |
| `npm run test:auth` | Unified sign-in tests (phone/email/Google/Apple linking, reset tokens, rate limits, flags, migration 005, phone + `/auth/validate` regression) against a **local** Postgres (`TEST_DATABASE_URL`, default `postgresql://ua@127.0.0.1:55433/ua_test`; the schema is wiped) |
| `npm run reset-data` | Delete `data/db.json` and uploaded avatars (JSON mode only; for Postgres drop/recreate the database) |
| `npm run db:import -- [path/to/db.json]` | One-time merge-import of an old `db.json` into Postgres (`DATABASE_URL` required, server stopped) |

`node scripts/smoke-persist.mjs`, run after `npm run smoke` and a server restart, checks that sessions and DMs survive restarts.
`node scripts/smoke-restart.mjs setup`, then restart the server, then `node scripts/smoke-restart.mjs verify` checks that users, profile edits/interests, photo, follows/unfollows, sessions (incl. a revoked one), DMs + read cursors and an open user-created room all survive (and an ended room doesn't).

---

## Features

**Phone sign-up (Clubhouse-style)**
- Welcome → phone number (with country picker) → 6-digit code → name → @username (live availability check and suggestions) → photo or color → bio → interests → follow suggestions → hallway.
- Returning users go phone → code → straight back in.
- OTP codes are 6 digits, hashed and single-use, expire after 5 minutes, allow 5 attempts, have a 30-second resend cooldown, and request rates are limited per connection.
- Sessions are random 256-bit tokens. The server stores only their SHA-256 hash (Postgres `sessions` table, or `db.json` locally), with a 60-day sliding expiry. Sign out revokes the session.
- The SMS provider is pluggable (`server/otp.ts`):
  - `demo` (default): shows the code on screen.
  - Other providers implement the `SmsProvider` interface.

**Rooms**
- The hallway lists live rooms started by real users. Anyone can start a room. Demo bots and seeded rooms are off by default; set `DEMO_SEED=1` to bring them back (bot speakers, chatter, DM auto-replies, simulated audiences).
- Roles: host, speaker and listener. Listeners raise hands; hosts invite them to speak, move people back to the audience, mute people or end the room.
- Leave quietly. Your seat is kept for 15 seconds through a page refresh. User rooms end automatically after 5 minutes with no humans in them.

**Live audio (LiveKit)**
- Every Open Lounge room maps to a LiveKit room named `openlounge-<id>`.
- Everyone subscribes. Only hosts and speakers get `canPublish`.
- When the server changes a role (invite to stage, move to audience), it updates LiveKit permissions through `RoomServiceClient.updateParticipant`. Host mutes also mute the published track server-side.
- Speaking rings come from LiveKit's active-speaker detection. Browsers that block autoplay get a "tap to enable audio" banner.
- Ending a room closes the LiveKit room.

**Chat and DMs**
- In-room chat:
  - compact bubbles with first names, role badges and soft timestamps;
  - the last 200 messages are kept, and chat is cleared when the room ends;
  - hosts and authors can delete messages; rate limit is 8 messages per 10 seconds;
  - on mobile, a drawer and preview pill keep the stage visible; on desktop, chat is a side column.
- 1:1 DMs:
  - stored durably (Postgres `dms`, or `db.json` locally; newest 1000 per conversation), with a conversation list, unread badges, typing indicators and read receipts;
  - open from a profile, or from any user in a room without leaving the room.

**Profiles and settings**
- Profiles show photo, @username, bio, followers and following, plus Follow and Message buttons. Edit profile lets you change name, username, bio, color and photo (upload or remove).
- Settings has a light (white) / dark (black) theme, saved per device with no flash on load, plus account info (masked phone) and sign out.

---

## Architecture

```
browser ──HTTPS──▶ Node server (server/index.ts, one port)
   │                 ├─ Next.js request handler (pages, assets)
   │                 ├─ GET  /api/health
   │                 ├─ POST /api/livekit/token   (Bearer <session token>, { roomId })
   │                 ├─ GET  /avatars/<userId>
   │                 └─ WebSocket /ws  ── server/ws.ts (WsHub) ── server/realtime.ts ── server/store.ts ── Postgres (DATABASE_URL) | db.json
   │
   └──WSS/WebRTC──▶ LiveKit Cloud (SFU)  ◀── server/livekit.ts (tokens, permissions, room cleanup)
```

**WebSocket protocol** (`server/ws.ts` and `src/lib/realtime.ts`). Messages are JSON:

```jsonc
{ "t": "req", "id": 7, "ev": "chat:send", "data": { "roomId": "…", "text": "hi" } }   // client → server
{ "t": "res", "id": 7, "data": { "ok": true } }                                       // server → client (ack)
{ "t": "evt", "ev": "chat:message", "data": { … } }                                   // server push
```

- The server keeps channel subscriptions (`user:<id>`, `room:<id>`) for fan-out.
- The connection is pinged every 25 seconds. The client reconnects with backoff and resumes its session with its token.
- The client uses `wss://` automatically when the page is served over `https://`. You can override the URL with `NEXT_PUBLIC_WS_URL`.
- Upgrade requests outside `/ws` are passed through to Next.js, so dev HMR still works.

**Main events:**
- `auth:*`, `session:resume`, `session:logout`
- `rooms:list`, `room:create/join/leave/end`
- `hand:set`, `self:mute`, `host:invite/mute`, `stage:toAudience`
- `chat:send/delete`, `dm:list/history/send/read/typing`
- `user:get/update/photo/follow`

**Server pushes:**
- `room:state`, `rooms:update`, `chat:message`, `chat:deleted`
- `dm:message`, `dm:unread`, `dm:typing`
- `follows:update`, `me:update`, `toast`, `room:ended`

**Key files**

| Path | Purpose |
|---|---|
| `server/index.ts` | HTTP server, API routes, WebSocket mount, graceful shutdown (flushes pending writes on SIGTERM) |
| `server/ws.ts` | Tiny WebSocket hub: request/ack, channels, heartbeat |
| `server/realtime.ts` | All realtime handlers plus the LiveKit permission sync |
| `server/livekit.ts` | LiveKit tokens, `setCanPublish`, `muteParticipantAudio`, `closeLiveKitRoom` |
| `server/otp.ts` | OTP service plus the pluggable SMS provider (demo) |
| `server/store.ts` | In-memory state (all reads), persisted on a debounce (users, sessions, follows, rooms, DMs) |
| `server/persistence.ts` | Storage backend selection (`DATABASE_URL` → Postgres, else `db.json`), JSON backend |
| `server/pg.ts` | Postgres backend: boot migrations, load, diff-based transactional saves |
| `server/migrations/*.sql` | Schema (applied automatically at boot, idempotent) |
| `src/components/AppProvider.tsx` | WebSocket client, session, current user, toasts |
| `src/components/auth/AuthFlow.tsx` | Sign-up and login screens |
| `src/hooks/useLiveKitAudio.ts` | LiveKit connection, mic, speaking indicators |
| `src/app/room/[id]/page.tsx` | Room screen (stage, audience, chat, hands, DMs) |

---

## Storage

| `DATABASE_URL` | Backend | Notes |
|---|---|---|
| set | **Postgres** | Production path. `server/migrations/*.sql` run automatically at boot (tracked in `schema_migrations`, advisory-locked, idempotent). The server retries the connection for ~30 s while the database starts, then exits with a clear error. |
| unset | **`$DATA_DIR/db.json`** | Local-dev fallback, logged at boot (a louder warning when `NODE_ENV=production`). Same behaviour as before. |

How it works: `server/store.ts` keeps everything hot in memory (all reads are served from memory, exactly as before). About 800 ms after a change, and on SIGTERM, it hands a snapshot to the backend. The Postgres backend diffs it against what it last wrote and upserts/deletes only the changed rows in one transaction; if the database is unreachable it retries with backoff (2 s → 60 s) and the app keeps working from memory.

**Stored in Postgres:** `users` (profile, bio, phone, photo version), `user_interests` (ordered), `follows`, `rooms` (metadata of open user-created rooms; removed when a room ends), `dms` (newest 1000 per conversation), `sessions` (SHA-256 token hashes, 60-day sliding expiry; expired rows are dropped at boot), `dm_reads` (read cursors), `openlounge_meta`.
**Memory only (unchanged):** who's in which room, presence, raised hands, mute, podium, speaking, in-room chat, reactions, join/leave events, and the demo bots + seeded rooms (only with `DEMO_SEED=1`; re-created on every boot, never stored).
**Files:** avatar images stay in `$DATA_DIR/avatars` (keep the `/data` volume).

**Moving from `db.json`:** point `DATABASE_URL` at an *empty* database and start the server with the old `DATA_DIR`. It imports `db.json` once automatically (`[store] importing … into Postgres`) and records it in `openlounge_meta`, so it never re-imports. Or, with the server stopped: `DATABASE_URL=… npm run db:import -- path/to/db.json` (merges; safe to re-run). `SKIP_JSON_IMPORT=1` disables the automatic import.

Local Postgres for development:

```bash
sudo apt install postgresql            # or: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=openlounge postgres:17
sudo -u postgres psql -c "CREATE ROLE openlounge LOGIN PASSWORD 'openlounge'" -c "CREATE DATABASE openlounge OWNER openlounge"
DATABASE_URL=postgresql://openlounge:openlounge@localhost:5432/openlounge npm run dev
```

---

## Deploy: Railway (app) + LiveKit Cloud (audio)

The repo includes a `Dockerfile` (multi-stage: `npm ci` → `next build` → slim runtime), `docker-entrypoint.sh` (chowns the root-owned Railway volume at `$DATA_DIR`, then drops to the unprivileged `node` user), `railway.json` (Dockerfile builder, start command, `/api/health` healthcheck with 120 s timeout, restart on failure, one replica), `.dockerignore` and `.env.example`.

- **Start command:** `/usr/local/bin/docker-entrypoint.sh /app/node_modules/.bin/tsx server/index.ts` (same as the image's ENTRYPOINT + CMD; equivalent to `npm start`). The server binds `0.0.0.0:$PORT`.
- **Healthcheck:** `GET /api/health` → `{"ok":true,"service":"openlounge","audio":"livekit"|"disabled","storage":"postgres"|"json"}`. The server only starts listening after Postgres is connected and migrated.
- **Postgres TLS** is picked automatically from the URL: `*.railway.internal` (the private `DATABASE_URL`) → plain connection inside Railway's private network; `*.rlwy.net` public proxy (`DATABASE_PUBLIC_URL`) → TLS without CA verification (Railway's proxy cert is self-signed); `?sslmode=require` → TLS without CA check (libpq meaning); `DATABASE_SSL=disable|require|verify` overrides. The boot log prints the choice and whether the live connection is encrypted.

1. **LiveKit Cloud:** create a project at <https://cloud.livekit.io>. Under **Settings → Keys**, create an API key. Note the WebSocket URL (`wss://<project>.livekit.cloud`), the API key and the secret.
2. **Railway:** create a project from this repo (or `railway up` from the folder). Railway detects `railway.json` and builds the Dockerfile.
3. **Postgres:** in the same Railway project click **+ New → Database → PostgreSQL**. Railway creates a `Postgres` service with its own `DATABASE_URL`.
4. **Variables** (Railway → Open Lounge service → Variables):
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}   # reference variable → private network URL, no TLS settings needed
   LIVEKIT_URL=wss://<project>.livekit.cloud
   LIVEKIT_API_KEY=<key>
   LIVEKIT_API_SECRET=<secret>
   DATA_DIR=/data
   SMS_PROVIDER=demo
   ```
   `PORT` is injected by Railway, and the server binds `0.0.0.0:$PORT`. On first boot the schema is created automatically (`[pg] applied migration 001_init.sql` in the deploy logs).
5. **Volume:** add a Railway volume mounted at `/data`. With Postgres it only holds uploaded **avatar images**; without it, profile photos are lost on redeploy (everything else is in Postgres).
6. **Domain:** generate a Railway domain. Railway terminates TLS, so the page is served over **https** and the browser connects to **`wss://<domain>/ws`** automatically. The microphone needs https, which this gives you.
7. Open `https://<domain>/api/health`. It should return `{"ok":true,"service":"openlounge","audio":"livekit","storage":"postgres"}`.

Notes:
- **Keep one replica.** Durable data is in Postgres, but every read is served from process memory and live room state (presence, hands, podium, room chat) is memory-only. Scaling out would need Redis pub/sub and shared presence in place of the in-memory store and `WsHub` channels.
- **Demo OTP is not secure.** Anyone can sign in as any number. The server logs a warning when demo OTP runs in production. Plug in a real OTP provider before sharing the URL publicly.
- Any Docker host works the same way (Fly.io, Render, a VPS behind Caddy or nginx). The proxy just needs to forward WebSocket upgrades on `/ws`.

### Optional external coturn relay rollout

Open Lounge normally uses its existing LiveKit connection path. The external coturn relay is an **optional, server-side** addition for 1:1 calls; it does not make the current Railway-hosted LiveKit SFU UDP-capable.

1. Keep `TURN_STATIC_SECRET` **unset** to retain the explicit empty-ICE configuration and current LiveKit/TCP behavior.
2. After review and in an approved staging environment only, set `TURN_STATIC_SECRET` to the same value configured in coturn's `use-auth-secret`. Set it in the application secret manager only — never in `NEXT_PUBLIC_*`, source control, browser code, logs, or support messages.
3. The call server then gives authenticated participants in a live 1:1 call a fresh coturn REST credential (6 h default, `TURN_CREDENTIAL_TTL_S`) and the approved TURN UDP/TCP/TLS endpoints. The static secret never reaches the client.
4. Run the forced-relay and device validation protocol in [`docs/ops/coturn-relay-validation.md`](docs/ops/coturn-relay-validation.md) against a staging URL before considering a release.
5. **Rollback:** remove `TURN_STATIC_SECRET` from the application environment and restart/redeploy the approved app target. No database or coturn configuration change is required; the application returns to the existing explicit empty-ICE/TCP path.

```bash
docker build -t openlounge .
docker run -p 3000:3000 -v openlounge-data:/data --env-file .env openlounge
```

---

## Demo vs. production

| Area | Now | For production |
|---|---|---|
| OTP | Demo provider shows codes | Real SMS provider, per-phone and per-IP rate limits, fraud checks |
| Storage | Postgres (or `db.json` locally), one process with an in-memory cache | + Redis pub/sub / shared presence for multiple instances; avatars to object storage |
| Audio | LiveKit Cloud (needs credentials) | Same; add LiveKit webhooks for presence reconciliation |
| Bots | Off by default; `DEMO_SEED=1` adds seeded rooms, bot speakers and chatter, simulated follower counts | Leave `DEMO_SEED` unset |
| Moderation | Host delete and mute, rate limits | Reporting, blocking, abuse tooling |

### Known limitations
- Without LiveKit credentials there is no audio. The UI says so, and everything else works.
- Bot "speakers" are visual only. They don't publish audio.
- A single Node process holds all state in memory; durable changes are written to Postgres ~800 ms after they happen (a hard crash can lose that last window, same as the old `db.json`).
- iOS IPA is not included (needs your Apple Developer cert on a Mac). An Android sideload APK is included — see [Android APK](#android-apk-sideload) below.

---

## Android APK (sideload)

A **debug** (sideload) APK wraps Open Lounge in a native WebView shell:

| | |
|---|---|
| File | `openlounge.apk` — **not built yet under the Open Lounge name**; it will be rebuilt after the Railway deploy (the last build was `clubroom.apk`, package `com.clubroom.app.debug`) |
| Package | `com.donnydey.openlounge.debug` |
| Version | 0.1.0 |
| Min Android | 7.0 (API 24) |
| Signing | Debug keystore (not Play Store–ready) |

The APK does **not** embed the Node server. After install, paste your deployed **HTTPS** Open Lounge URL (Railway / Render / Fly). Mic + LiveKit need HTTPS. Tap the gear icon anytime to change the URL.

### Install on your phone

1. Copy `openlounge.apk` to the phone (USB, Drive, email, AirDrop-to-Files, etc.).
2. Open the file in **Files** / **Downloads**.
3. If Android blocks it: **Settings → Apps → Special app access → Install unknown apps** (or **Settings → Security → Unknown sources**) and allow the app you're installing from (Chrome, Files, Drive, …).
4. Tap **Install**. Launch **Open Lounge**.
5. On first launch, enter your Railway (or other) URL, e.g. `https://openlounge-production.up.railway.app`, then **Save & open**.
6. Allow **microphone** when prompted (needed for live rooms).

### Rebuild the APK

```bash
# Needs JDK 17+ and Android SDK (ANDROID_HOME)
cd android
./gradlew assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
```

Source: `android/` (WebView shell with mic/camera permissions and WebRTC permission bridging for LiveKit).

### Connect the APK to Railway + LiveKit

1. Deploy this Node app to Railway with a Railway Postgres database (see [Deploy](#deploy-railway-app--livekit-cloud-audio)).
2. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` on the Railway service.
3. Install `openlounge.apk`, open it, paste `https://<your-railway-domain>` and allow the mic.

Full steps: [`docs/android-install.md`](docs/android-install.md).
