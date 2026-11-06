# DO-only calling authority / existing-platform bridge

## Boundary

The existing authenticated application remains authoritative for sessions, user identity/profile, calling policy/blocks/follows, room presence/audio admission, history, and APNs/FCM/web push. In production `wireCalls` **does not instantiate CallService/rcRelay**. There is no legacy engine fallback. Only a metadata-verified production process on DO droplet608073501 runs call lifecycle, first-answer, public prekeys, sealed `rc:*` relay, media authorization and Pion ICE credential issuance. Its bundled dependency graph contains no platform DB/cache, auth provider or push implementation. It rejects platform/test credential environment variables.

The implementation remains bespoke OLX3DH + interim BSD M152 WebRTC, **not Signal/RingRTC/libsignal binaries**. One PeerConnection per call. Media remains end-to-end WebRTC; the MIT Pion TURN process relays encrypted ICE traffic, not decoded media. No AGPL component.

## Transport / authentication

Authenticated platform WS connection UID and server-generated connection ID are forwarded to `https://turn.openlounge.app:18443/bridge/calling`. Never trust identity in a browser payload. The DO process calls `https://openlounge.app/api/internal/calling-platform` for a narrow allowlist of policy/presence/audio admission/history/push/emit effects. URLs pin scheme, host, port and path, reject credentials/query/fragment, and never follow redirects. HTTP localhost override exists only for isolated tests and is rejected in production.

Two independent >=32-byte HMAC keys: CALLING_TO_DO_KEY (audience calling), CALLING_TO_PLATFORM_KEY (audience platform). Signature binds protocol version, audience, POST, exact path, timestamp, random nonce, receiver boot epoch, and SHA256 of the exact body. Clock window30s, nonce replay window60s; process restart changes receiver epoch. Maximum body256KiB. Requests have stable operation IDs with body-bound response dedupe120s; changed body/actor/action conflicts. Transient failures are retryable, successful effects are cached, and each retry gets a new signed nonce. External bad-auth failures are bounded. Neither bridge accepts demo account creation/session auth.

`call:start`/`call:accept` require `ol-rc-v1`; old native shells are explicitly directed to upgrade, never sent to an old media engine. Upgraded native shells advertise this capability, and iOS native control requests tag the protocol. Unauthenticated/outsider call/prekey/message access is rejected.

## Primary state / recovery

DO stores public prekeys atomically with serialization; no private/session keys or SDP are stored server-side. A fsynced active-call metadata ledger and effects outbox recover after authority restarts: old calls end as failed (never silently resurrect), history is retried idempotently, primary audio leases are released, and participants receive ended state. History acknowledgements await successful primary persistence. The outbox retries release independently if history is temporarily unavailable.

Generic audio-admission leases (user, opaque owner, expiry) live **only in the existing primary PostgreSQL pool**, additive migration035. This is not a second calling lifecycle engine/database. They load before accepting traffic and prevent room/call races across primary restart. Atomic two-user admission uses deterministic primary-user row locks. DO renews leases; release is owner scoped so an old effect cannot evict a new call. Native notification decline remains platform-verified, callee-only, non-active and single-use; stable nonce-derived DO request IDs make transport retries safe, and temporary failures do not burn the capability. Immediate authenticated background-visibility changes preserve push fallback.

## TLS operations / rollback

New Node HTTPS18443 and Pion TLS14443 share a root-managed certificate-generation directory at `/var/lib/openlounge-calling-tls/current`. Root helper validates normal hostname, >7d validity and matching public keys before atomically switching a generation. A separate additive Certbot deploy hook HUPs only these new services; existing coturn hook/services are not modified/stopped. Both processes validate a replacement before updating the TLS context; malformed replacements keep the last good context. Existing connections/allocations survive hot reload. Public certificate fingerprint/expiry and actual trusted TLS payload tests are evidence, not just file existence.

Production config/source/binaries are backed up under `/var/backups/openlounge-calling/`; restore only owned new files/services. Remove only newly added labeled18443 and Pion firewall rules if rolling those back. Never restore an entire firewall over concurrent changes; never stop old coturn/SFU/relay or delete DO resources. Production frontend rollback uses the recorded prior successful app deployment and prior scoped bridge env values. No Cloudflare or other calling host.

## Required release evidence

Run all calling tests, real separate-host-implementation authenticated WS integration, adversarial auth/replay/authorization/idempotence, primary audio lease/restart/history/native decline, trusted TLS hot-renewal, full Next build, Android unit/signature gate, and actual Mac iOS compile/signature/AVAudioSession-owner gates. Preserve existing noncalling suites. Exact server-emitted normal-hostname TURN URLs must work from an ordinary browser network; public-IP tests do not prove that. Then perform all42 native cross-platform cells and >10min TURN renewal with actual heard audio/rendered camera/network handoff. Headless synthetic RTP is never a physical-device claim. Do not label signed artifacts or a deployed authority as end-to-end verified until those gates pass.
