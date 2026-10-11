# Mediasoup SFU option: direct UDP media design

> **Status:** Design only — no code, deployment, firewall, Railway, coturn, database, DNS, or secret change is authorized by this note.
>
> **Decision:** Keep LiveKit-over-TCP as the production default. A Mediasoup SFU is a viable future path to direct UDP media, but it is **not** a drop-in configuration change and cannot safely share the existing media Droplet unchanged.

## Executive assessment

The current Open Lounge call pipeline uses the Railway application as control plane and a LiveKit room for media. The current LiveKit SFU deployment has no inbound UDP path, so its usable server-side path is TCP. The DigitalOcean media Droplet is now a hardened coturn relay, which improves the client-side reachability path but does not change that LiveKit/Railway server-side constraint.

Mediasoup could place the SFU on a UDP-capable host and therefore give clients a direct WebRTC media path to the DigitalOcean region. It shifts responsibility from LiveKit into Open Lounge: creating transports, enforcing roles, signaling every producer/consumer lifecycle event, reconnection, observability, worker health, and capacity handling become application-owned. [Mediasoup explicitly supplies no signaling protocol](https://mediasoup.org/documentation/v3/communication-between-client-and-server/), so this work cannot be skipped.

The existing `openlounge-media` Droplet is a useful coturn baseline, but is **not an SFU pilot or production target**. coturn already owns UDP `50000-60000` for relay allocation and TCP `443` for TURN/TLS. Mediasoup needs its own RTC port allocation and an application-controlled signaling/control channel. Reusing either existing binding would cause a port collision; adding a second public listener on TCP 443 would conflict with coturn. Co-locating an SFU would also make coturn and the SFU compete for the same shared CPU, memory, NIC, and failure domain.

## Current state and proposed target

| Concern | Current production path | Future Mediasoup option |
|---|---|---|
| Call control | Open Lounge Node server and raw WebSocket events | **Unchanged authority:** Open Lounge continues to authorize call state, roles, moderation, and expiry. |
| Media engine | LiveKit SFU used by the current `CallEngine` and room-audio hook | A Mediasoup Node service plus C++ worker process on the UDP-capable media host. |
| Client media library | `livekit-client`, LiveKit room/token lifecycle | `mediasoup-client`, explicit device, send/receive transport, producer and consumer lifecycle. |
| Signaling | Existing Open Lounge WebSocket plus LiveKit signaling | Reuse the authenticated Open Lounge WebSocket for `ms:*` request/response events; Mediasoup itself does not supply signaling. |
| Preferred media path | LiveKit/Railway TCP under the current deployment constraint | Direct DTLS/SRTP over UDP to the media host; coturn relay remains available for restrictive client networks. |
| Fallback | Current LiveKit/TCP path | Per-call backend selection: on Mediasoup admission/connect failure, start a **new** call attempt on LiveKit/TCP. Never migrate an active call mid-stream. |
| Permissions | LiveKit token grants plus server-side `RoomServiceClient` permission changes | Signed, short-lived call-scoped admission plus Open Lounge-enforced producer/consumer policy. Host/speaker/listener rules must be reimplemented. |
| Operations | LiveKit service telemetry and failure handling | Worker health, transport/ICE/DTLS events, packet loss/jitter, bitrate, producer/consumer cleanup, alerting, and capacity limits are owned by Open Lounge. |

## Non-negotiable host and network constraints

### 1. Allocate a separate media UDP range

coturn is already configured with UDP relay ports `50000-60000`. Mediasoup must not bind that range. The later SFU approval must reserve a **non-overlapping** range, for example UDP `40000-44999`, and add the exact same range to both the DigitalOcean firewall and UFW before the process is started. The precise range should be minimized after a small pilot proves the required concurrency.

Mediasoup’s documentation describes its RTC range as serving ICE, DTLS and RTP, and its current API uses transport listen information for that allocation. A `WebRtcServer` can bind explicit UDP and TCP listeners; this design uses an explicit UDP listener only during the first pilot. When a listener binds a wildcard interface, its `announcedAddress` must be the approved publicly routable IPv4 address; otherwise it must bind that public interface directly. IPv6 must be an explicit later policy choice, not an accidental candidate. Stage 1 must validate the externally gathered and selected candidate address from a network outside the media host. See the [Mediasoup API](https://mediasoup.org/documentation/v3/mediasoup/api/).

Do **not** assume UDP 443 is available for Mediasoup merely because the approved firewall permits it. It is part of the current media firewall envelope and requires a fresh on-box listener inventory plus a separate approval before any new process may bind it. Do **not** add a Mediasoup TCP media listener in the first pilot. The fallback for networks where direct UDP does not work remains the existing LiveKit/Railway TCP path, not an unreviewed extra listener on the media Droplet.

### 2. Preserve coturn’s TLS port and use the existing application signaling plane

coturn owns TCP 443 for `turns:`. Mediasoup has no built-in signaling server, and an HTTPS/WSS process cannot simply bind the same port. The client should continue to signal through the existing authenticated Open Lounge WebSocket on Railway. A future media gateway can maintain an authenticated outbound control channel to the Open Lounge application, or the application can broker request/response messages to it. Neither design needs a new public HTTP port on the media Droplet for the initial pilot.

This prevents an accidental second public control endpoint, preserves the coturn certificate path, and keeps client authentication in one place. It also means a Mediasoup deployment is a new backend integration, not a local-only package install.

### 3. Treat the $12 Droplet as a pilot envelope, not production capacity

The existing Basic Droplet is 1 vCPU / 2 GiB / 50 GiB / 2 TB at **$12/month** according to [DigitalOcean’s current pricing](https://www.digitalocean.com/pricing/droplets). Co-locating an SFU would appear to add $0 of infrastructure cost, but that option is rejected: it would let an SFU worker degrade the production coturn relay through shared CPU, memory, network, and host failure. A pilot and every canary require a **separate, capacity-approved SFU host**; the existing Droplet remains coturn-only.

A Mediasoup Worker is a C++ subprocess that runs on one CPU core; routers on that worker share that core. Mediasoup recommends no more workers than CPU cores and distributing rooms across hosts as capacity grows ([scalability documentation](https://mediasoup.org/documentation/v3/scalability/)). DigitalOcean separately classifies Basic Droplets as shared CPU for bursty/dev-test workloads and advises dedicated CPU when variable performance is unacceptable ([plan guidance](https://docs.digitalocean.com/products/droplets/concepts/choosing-a-plan/)).

| Option | Current public list price | Increment vs. current $12 | Recommendation |
|---|---:|---:|---|
| Keep 1 vCPU / 2 GiB Basic | $12/mo | $0 | Retain as coturn-only; do not install an SFU. |
| Resize the coturn host to 2 vCPU / 2 GiB Basic | $18/mo | +$6/mo | Does not isolate coturn from the SFU; not a Mediasoup canary recommendation. |
| Resize the coturn host to 2 vCPU / 4 GiB Basic | $24/mo | +$12/mo | Adds headroom but retains a shared failure domain; not a Mediasoup canary recommendation. |
| Dedicated CPU media host | Provider/configuration dependent | To be priced and separately approved | Production candidate after staged metrics justify it; separate coturn/SFU hosts are preferred as load grows. |

Those figures are infrastructure prices only; they exclude engineering, monitoring, bandwidth overages, backup, and operational response. No capacity number (rooms, callers, or video participants) is promised until measured with Open Lounge’s codec and bitrate configuration.

## Required application changes when implementation is later approved

The existing implementation is tightly connected to LiveKit: `server/livekit.ts` mints join tokens and changes permissions; `src/lib/calls/engine.ts` owns a LiveKit `Room`, reconnects it, and publishes tracks; room audio uses the LiveKit client as well. A migration must introduce a backend-neutral interface rather than branching call behavior throughout the UI.

1. **Backend adapter.** Define a `MediaBackend` boundary with `issueJoin`, `connect`, `publish`, `subscribe`, `mute`, `remove`, `closeRoom`, and `reconnect` operations. Keep the existing LiveKit implementation as the default adapter. Add a Mediasoup adapter behind a server-side feature flag; do not change the default while the pilot runs.
2. **Admission and authorization.** The Open Lounge server mints a brief, signed, call-scoped Mediasoup admission token containing only call ID, user ID, role, expiration, and a nonce. The media service verifies it, enforces single-use/expiry, and never receives or returns the coturn static secret. Existing coturn REST credentials remain server-minted and short-lived.
3. **Signaling contract.** Add idempotent, authenticated WebSocket request/response events for router capabilities; create/connect send and receive transports; produce/consume; pause/resume; close; and ICE restart. Mediasoup requires the application to signal matching client/server transports, producers and consumers; closure events must likewise be conveyed to the peer.
4. **Role enforcement.** Map host/speaker/listener policy to server-side producer permissions. A listener can receive but cannot create an audio/video producer; host mute closes or pauses the appropriate producer; ending a room closes the router and rejects new joins. Do not rely on a hidden UI control for enforcement.
5. **Client migration.** Replace only the media connection layer with `mediasoup-client`; preserve the current microphone processing, device controls, audio unlock, self-view framing, call UI, quality UI, and native bridge behavior. Add a capability gate for supported browser/WebView versions before opt-in.
6. **Observability.** Emit privacy-safe metrics for call admission, ICE selected tuple type/protocol, DTLS state, first-media time, reconnect duration, bitrate, jitter, packet loss, worker death, CPU, memory, and port exhaustion. Do not store media, SDP, TURN usernames, credentials, or user call content in logs.

## Staged rollout with explicit rollback

| Stage | Scope and success gate | Default / rollback |
|---|---|---|
| 0 — design review | Approve the architecture, a non-overlapping UDP range, control-channel approach, security model, metrics, and pilot capacity budget. | No host or application changes. |
| 1 — disposable lab | Use an isolated, non-production SFU host — never `openlounge-media` — for two-party audio/video calls on non-production identities. Force direct UDP and forced coturn relay separately; test ICE restart, network change, worker restart, and externally selected candidate address. | Destroy the lab host/process and remove only its new firewall rule. Production coturn and LiveKit remain untouched. |
| 2 — staging canary | Keep the adapter behind a staging-only feature flag on the isolated SFU host. Exercise desktop Chrome/Safari/Firefox and iPhone/Android at 375/412/820/1280 px. Compare first-audio latency, packet loss, reconnects, and failure rate to LiveKit/TCP. | Disable the staging flag; new calls use LiveKit. No database migration or data rollback is needed. |
| 3 — internal production canary | Require a separately capacity-approved SFU host with production coturn isolated before opting in a small named cohort to audio-first calls. Keep video and rooms on LiveKit until audio reliability meets the predefined threshold. | Flip the per-call selector back to LiveKit for new calls. Let already connected calls end normally; never force an in-call backend swap. |
| 4 — graduated rollout | Expand only after capacity, direct-UDP success, relay fallback, device matrix, alerting, and incident runbook meet the release gate. Keep coturn and SFU on separate hosts; move to dedicated compute when metrics require it. | Stop new Mediasoup admissions; preserve LiveKit as the durable fallback while investigation occurs. |

### Release gates

A stage may advance only when all of the following hold:

- the direct-UDP and forced-relay scenarios both establish encrypted media and carry two-way RTP;
- authentication rejects expired, replayed, cross-call, and cross-user admission tokens;
- host/speaker/listener permissions hold at the server, not merely in the client;
- a network change triggers the documented ICE restart/reconnect behavior without a silent connected state;
- the Chrome/Safari/Firefox plus iPhone/Android viewport matrix completes without microphone, camera, self-view, control-layout, or audio-route regression;
- CPU, memory, UDP port occupancy, packet loss, jitter, first-media time, and worker restart behavior remain within thresholds approved before the canary; and
- the SFU host is separate from production coturn, and a pressure/restart test proves a Mediasoup fault cannot degrade coturn allocation or relay traffic; and
- LiveKit fallback can be selected for new calls without changing coturn, secrets, the database, or active-call state.

## Security and operations boundaries

- Keep SSH key-only access, coturn’s current `use-auth-secret` mode, relay quotas, denied peer ranges, and automated certificate renewal unchanged.
- Never expose `TURN_STATIC_SECRET`, the coturn shared secret, media-service signing keys, or long-lived credentials to browser JavaScript, logs, Git, screenshots, or issue comments.
- Treat the Mediasoup gateway as a new service identity with narrowly scoped admission-token verification keys and structured, redacted logs.
- Run the future service as a non-root, supervised process; fail closed on a worker death, port bind failure, invalid token, or control-channel loss. Alert rather than silently falling back to an unauthenticated listener.
- Do not change Railway, its database, or coturn as part of the design phase. Any later firewall, systemd, package, environment, or service action requires a separately reviewed change and a reversible runbook.

## References

| Source | Relevance |
|---|---|
| [Mediasoup — Communication Between Client and Server](https://mediasoup.org/documentation/v3/communication-between-client-and-server/) | Mediasoup is signaling-agnostic; the application owns transport/producer/consumer signaling. |
| [Mediasoup — API](https://mediasoup.org/documentation/v3/mediasoup/api/) | Worker model and explicit WebRTC transport listener/port configuration. |
| [Mediasoup — Scalability](https://mediasoup.org/documentation/v3/scalability/) | Single-core worker model, router/SFU responsibilities, and multi-host scaling guidance. |
| [LiveKit — Ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/) | UDP, TCP fallback, and TURN/TLS exposure requirements for comparison. |
| [DigitalOcean — Droplet pricing](https://www.digitalocean.com/pricing/droplets) | Current Basic Droplet list prices. |
| [DigitalOcean — Choosing a plan](https://docs.digitalocean.com/products/droplets/concepts/choosing-a-plan/) | Shared-versus-dedicated CPU guidance and production workload considerations. |
