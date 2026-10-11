# Mediasoup + coturn co-location plan — **review required before install**

> **Status: no deployment action is authorized by this file.** It is a review package only. No package, firewall, DNS, secret, systemd, Railway, database, coturn, or Droplet change has been made.
>
> **Flag:** `CALL_SFU=layered` is **off by default**. Without it, or while the authenticated SFU gateway is disconnected, every call remains on the existing LiveKit/TCP path unchanged.

## Scope and safety boundaries

This plan prepares a deliberately constrained pilot on the existing `openlounge-media` host **only if the Chief of Staff accepts the co-location exception**. coturn remains the priority service and retains its existing configuration, certificate, 3478 UDP/TCP, 443 TLS/TURN, and `50000-60000` relay allocation range.

- No change has been made to `openlounge-media` (`165.232.137.71`).
- No change is proposed for Railway, the database, the existing LiveKit deployment, coturn credentials, or `TURN_STATIC_SECRET`.
- The SFU is a separate non-root `openlounge-sfu` service and systemd cgroup; it is not a container sharing coturn's process namespace.
- Browser signaling remains on the authenticated Open Lounge WebSocket. The SFU has only an outbound **allowlisted WSS** broker connection and a loopback-only `/healthz` listener, so no new public control port or path is opened. Startup refuses `ws:`, credentials in the URL, or a hostname mismatch before a gateway secret can be sent.
- Direct UDP is the first path only. The SFU publishes **no TCP candidate**. If UDP cannot connect within approximately four seconds, fails, loses transport, or its worker dies, the app issues new short-lived LiveKit credentials and both participants rebuild media over the pre-existing LiveKit/TCP path automatically.

## Exact partition and limits

| Concern | coturn (priority) | Mediasoup pilot (bounded) |
|---|---|---|
| Unix identity | Existing `coturn` service user | New `openlounge-sfu` system user; `/usr/sbin/nologin` |
| Service/cgroup | Existing `coturn.service` plus reviewed reservation drop-in | `openlounge-mediasoup-sfu.service` in `openlounge-sfu.slice` |
| CPU policy | `CPUWeight=1000`; no cap, so it can serve relay traffic | **Hard cap `CPUQuota=35%`**, `CPUWeight=50`, one worker only |
| Memory policy | Protected `MemoryMin=768M`, `MemoryLow=768M`, `MemoryHigh=1024M`, hard `MemoryMax=1280M` | **Hard `MemoryHigh=384M`, `MemoryMax=448M`**, `OOMPolicy=stop`, `TasksMax=128` |
| Port ownership | TCP/UDP 3478, TLS/TURN 443, UDP 50000-60000 | Exactly UDP `40000-49999` only; runtime and firewall helpers fail closed for every other range |
| Logging | Existing coturn logs remain separate | systemd journal under `openlounge-mediasoup-sfu.service`; no SDP, media, token, static secret, or TURN credential logging |
| Network | Existing firewall unchanged until reviewed | One new **UDP-only** range after review; health is `127.0.0.1:8081` and is never exposed |

On the 1-vCPU / 2-GB host, a `448M` SFU cap, two-call maximum, and **four-session hard limit** (one active browser session per call participant) make this an **audio-first lab/canary only**, not a capacity promise. Direct sessions are reclaimed on browser WebSocket close, explicit leave, gateway loss, call close, and transport-timeout fallback. If coturn shows memory pressure, packet loss, allocation errors, or CPU contention, the immediate rollback is `systemctl stop openlounge-mediasoup-sfu` plus removal of the one new UDP firewall rule; LiveKit remains available for all new calls.

## Required review decisions before any host action

1. Approve the co-location exception and the hard limits above, including the possibility that the SFU is stopped by its own cgroup instead of starving coturn.
2. Approve the `40000-49999/udp` rule in **both** UFW and the DigitalOcean cloud firewall. Do not open a TCP range in this pilot: it would defeat the required LiveKit/TCP fallback behavior.
3. Provide a **staging** `OPENLOUNGE_GATEWAY_WS_URL` and matching `OPENLOUNGE_GATEWAY_HOST`, plus two unique 32+ byte random secrets: `MEDIASOUP_GATEWAY_SECRET` and `MEDIASOUP_ADMISSION_SECRET`. They must not reuse coturn/TURN values and are set only in a `0600 root:root` env file.
4. Confirm that `CALL_SFU=layered` will be set on **staging only** after the gateway and `/healthz` are healthy. The application secret values must be supplied by the reviewer; this branch never applies Railway environment changes.
5. Confirm backup destination capacity. `media-sfu/deploy/backup-coturn-config.sh` takes a root-readable tarball and SHA-256 checksums before any install action.

## Review-only runbook

1. On the target host, copy this review branch without executing scripts.
2. Run the read-only `media-sfu/deploy/preflight.sh`; capture listener inventory, cgroup v2 controller availability, coturn health, UFW rules, memory, and core count.
3. Run `backup-coturn-config.sh` as root; preserve the returned backup path and checksums.
4. Review the resulting backup manifest, `systemd-analyze verify` output, UFW/DigitalOcean rules, source lockfiles, and root-owned `/etc/openlounge-mediasoup-sfu.env` permissions (`0600 root:root`).
5. Only after written approval, run the guarded install and guarded UDP helper with their explicit approval variables. Verify `systemctl status`, `curl http://127.0.0.1:8081/healthz`, cgroup limits, coturn allocation, and external UDP candidates.
6. Set staging-only `CALL_SFU=layered` and the matching admission/gateway secrets. Run the forced-direct-UDP and forced-LiveKit fallback checklist; test desktop Chrome/Safari/Firefox plus iPhone/Android at 375/412/820/1280 px. Do not target production.

## Rollback

1. Set `CALL_SFU` unset/off on staging: all **new** calls use LiveKit immediately.
2. `systemctl stop --now openlounge-mediasoup-sfu`; no coturn restart is needed.
3. Remove only the reviewed `40000-49999/udp` rule from UFW and the DigitalOcean firewall.
4. Remove the `coturn.service.d/20-openlounge-reserve.conf` drop-in only if its addition is being reversed, then `systemctl daemon-reload`; do not replace or edit coturn configuration.
5. Restore the backup only if a separate review identifies an unexpected coturn config change. The normal SFU rollback never touches it.

## Included artifacts

- `media-sfu/src/index.mjs` — single-worker brokered UDP SFU with loopback `/healthz`, signed admission verification, `MEDIASOUP_MAX_CALLS=2`, and fail-closed gateway behavior.
- `media-sfu/deploy/openlounge-mediasoup-sfu.service` and `openlounge-sfu.slice` — non-root process isolation and hard cgroup caps.
- `media-sfu/deploy/coturn-reserve.conf` — coturn-first CPU and memory reservation.
- `media-sfu/deploy/preflight.sh`, `backup-coturn-config.sh`, `install-reviewed.sh`, and `allow-udp-pilot.sh` — read-only or explicit-opt-in operational steps.
