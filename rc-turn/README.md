# Open Lounge-owned ICE relay candidate

A separate MIT Pion TURN v4.1.4 process, **not Signal's relay** and not a coturn wrapper. Native/browser WebRTC remains the media engine; this process forwards encrypted ICE packets only. No AGPL components. Exact runtime notices: THIRD_PARTY_NOTICES.md.

## Deployment boundary

Build/test/run ONLY on verified DigitalOcean droplet608073501 (`openlounge-media`,165.232.137.71). Check metadata ID before every mutation. Never deploy this service to Railway/Cloudflare or replace/stop existing coturn/SFU/WS services without enumerating their other consumers. The checked-in systemd unit is the additive candidate, not a production cutover.

Listeners: UDP/TCP13478, trusted TLS14443, relay UDP62000–62999. HMAC-SHA1 TURN REST credential format matches `mintTurnIceServers`; timestamp expiry and call-scoped username required. Server rejects private/loopback/link-local/multicast peer permissions. Global allocation bound256. Firewall exposes only the isolated listener/range; service has DynamicUser, memory192M/CPU50%, strict system protection. AF_NETLINK permits Go's interface enumeration; omitting it caused a demonstrated startup failure. Credentials are systemd-loaded, never committed.

Environment: `RC_TURN_PUBLIC_IP`, strong `RC_TURN_SECRET`; optional listen/realm variables in main.go. Current TLS files are the existing droplet certificate files loaded with systemd credentials (no coturn runtime dependency). Certificate renewal must restart/reload this service independently: startup snapshot is not a hot reload.

On DO source release directory:

```sh
gofmt -w *.go
go test -race ./...
go build -trimpath -ldflags='-s -w' -o openlounge-rc-turn.new .
# Back up active binary/unit first, atomically rename new binary, restart ONLY candidate.
# Source environment silently; do not print secrets.
RC_TURN_TEST_ADDR=127.0.0.1:13478 go test -race -run TestLiveTwoPeerRelay -v .
RC_TURN_TEST_ADDR=127.0.0.1:14443 RC_TURN_TEST_TLS=1 go test -race -run TestLiveTwoPeerRelay -v .
```

Both live tests perform two authenticated allocations and verify actual bidirectional relayed payloads; TLS test checks the trusted certificate and hostname, not insecure skip-verify.

## Credential leases

The pinned Pion server re-authenticates allocation Refresh/CreatePermission/ChannelBind, so expired 600-second credentials cannot be assumed to support a long call. Clients now proactively renew at eight minutes; caller drives the same-PC ICE restart and callee fetches its own fresh config before answering a restarted generation. Timers are cancelled at call close. Accelerated Chromium lease and RTP progress tests pass; real >10-minute cross-platform calls remain required.

## 2026-11-06 evidence / rollback

Deployed active additive service `openlounge-rc-turn`; public Chromium forced-TURN/TCP synthetic audio packets + decoded canvas video + camera toggle + same-PC synthetic online/ICE restart passed. This is NOT physical audio/video or Wi-Fi/cellular verification. Candidate server ICE credentials now select these Pion listeners, not coturn. Live production has **not** switched. Public-IP Chromium TURN/TCP passed, but the exact server-emitted hostname URLs gathered zero candidates in this box; external hostname/TLS and physical-network gates remain outstanding. Public Google DNS resolves the hostname to the correct DO IP.

Backups: `/var/backups/openlounge-calling/20261106-rc-turn/`; active release `/opt/openlounge-rc-turn/releases/20261106/`. Rollback stops/disables ONLY `openlounge-rc-turn` and removes ONLY the four added labeled UFW/cloud-firewall rules (UDP13478,TCP13478,TCP14443,UDP62000–62999). Do not restore the whole firewall over concurrent changes. Existing coturn/signaling/SFU remain untouched. Local deployment/evidence/hashes and firewall snapshots are in `/workspace/builds/calling-release-20261106/`.

Production acceptance still requires coherent main-platform auth/policy/push/presence bridge to a DO-only calling control service, then the full physical/native/browser matrix. The isolated loopback rcRelay service is a smoke candidate with synthetic users, not that production bridge.
