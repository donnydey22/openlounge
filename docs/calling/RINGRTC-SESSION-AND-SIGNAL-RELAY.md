# Open Lounge calling — RingRTC session model + Signal-model relay (clean-room)

> **Current implementation/deployment status — November 6, 2026, MST (America/Phoenix).** Historical sections below describe earlier commits and do not override this status. User authorization t4997u covers scoped builds/deploys; no additional deploy approval is needed.
>
> All three clients have one-PC WebRTC audio/video and sealed rc:* signaling, with no PJSIP/mediasoup/LiveKit calling fallback. This is OLX3DH plus interim BSD M152 WebRTC, **not actual Signal/RingRTC binaries or certified parity**. Android startup executor deadlock, cold-start key retry, shared video-slot/SDP concurrency, and authenticated-before-ratchet mutation are being covered by regression gates.
>
> Server public-prekey storage is now optionally durable via `RC_PREKEY_DIR` (atomic per-user files, serialized directory operations). These are public keys; no native private keys are uploaded. Complete isolated PostgreSQL calls gate: **172/172 pass**, including updated P2P consent/auth/short-lived TURN assertions replacing obsolete LiveKit-token contracts, not deleted failing tests. Typecheck and production Next build pass.
>
> Verified DO droplet608073501 (`openlounge-media`,165.232.137.71) now has additive active `openlounge-rc-turn` (MIT Pion TURN4.1.4) and loopback-only `openlounge-rc-candidate` (isolated synthetic account store; not production). Authenticated rcRelay smoke verifies participant isolation, sealed roundtrip and ended-call denial. Pion unit/race tests plus real TCP and trusted-TLS two-peer payload relay pass. A real headless Chromium forced-relay synthetic audio-packet/decoded-video/camera-toggle/same-PC ICE-restart gate passes using the droplet public-IP TURN/TCP URL; the exact server-emitted hostname URL matrix currently gathers zero candidates in this box and times out (public Google DNS correctly resolves the hostname to the designated droplet, so do not claim this hostname matrix passed); this is **not physical audio/video or actual Wi-Fi/cellular switching**. See `rc-turn/README.md` for ports, notices, backups and rollback.
>
> **Production cutover is still outstanding:** current `openlounge.app` WS calling state is coupled to its main app/platform store, push, room gates and presence. The isolated DO candidate deliberately uses no production DB/auth data. A coherent authenticated platform bridge/direct calling route is required before changing production calling routes; deploying the whole current app to Railway would violate the DO-only calling boundary, while a second full app sharing the production DB/cache would endanger chats/rooms. Existing coturn/SFU/old signaling remain running for other consumers; production ICE URLs have not switched. No production web calling or native real-device verification is claimed. Existing `/download` Android47/iOS117 have not been relabeled or replaced. Required remaining native/browser matrix is documented in `/workspace/builds/calling-release-20261106/`.

Branch `ringrtc-bindings` (web+server), `ringrtc-bindings` (Android), `ringrtc-bindings` (iOS). Oracle pins: RingRTC 2.74.0,
signalapp/webrtc 8037b. **No RingRTC / libsignal code or binaries are included** (both AGPL-3.0). Everything here is an
independent implementation of their *behavior*. Literal embeds live only behind LICENSE-GATED seams (below) and stay off.

## Shared contract (byte-identical on web / iOS / Android)
* Identity: X25519 DH key `IKdh` + Ed25519 signing key `IKsig` (libsignal uses one XEdDSA key; two keys avoids XEdDSA).
* Bundle: `{ikDh, ikSig, spkId, spk, spkSig=Ed25519(IKsig, spk), opkId?, opk?}` — base64url, no padding.
* X3DH `OLX3DH-v1`: `SK = HKDF-SHA256(0xFF*32 ‖ DH(IKa,SPKb) ‖ DH(EKa,IKb) ‖ DH(EKa,SPKb) [‖ DH(EKa,OPKb)], salt=0*32, info="OLX3DH-v1", 32)`.
* Chains: `HKDF(SK, salt=0*32, info="OLCallChain-v1", 64)` → `[0,32)` initiator→responder, `[32,64)` responder→initiator.
* Per message n: `mk=HMAC(ck,0x01)`, `nonce=HMAC(ck,0x03)[0..12)`, `ck'=HMAC(ck,0x02)`; header `0x01‖u32be(n)`;
  `AAD = IKdh_initiator ‖ IKdh_responder ‖ header`; AES-256-GCM. Skipped keys ≤256 (out-of-order ICE), replays rejected.
* Envelope `{v:1, n, ct, pre?:{ikDh, ikSig, ek, spkId, opkId?}}`; `pre` attached until the first peer reply.
* Wire `rc:msg {callId, dev, envs:{peerDeviceId: Envelope}}`: Signal multi-device — caller fans out to every callee
  device bundle, locks to the first device that replies; others drop. Bundles are per (user, device).
* Fresh session per call (one-time prekey consumed) — Signal calls likewise ride the messaging session; full Double
  Ratchet DH steps are unnecessary inside one short call. Vectors: `tests/calls/olx3dh-vectors.json` (verified: web node test, Android Robolectric, Swift swift-crypto on Linux).
* Inner plaintext = the existing `rtc:signal` JSON (`ready/offer/answer/candidate/restart/bye`, callId/gen/seq).
* Call state model = RingRTC `CallState`/`CallEvent`/`HangupType` (idle, starting, ringing, connecting, connected,
  reconnecting, ended; hangup normal/accepted/declined/busy/needPermission/timeout/failed). One active call; 2nd → busy.

## Server (DigitalOcean calling droplet ONLY — historical 165.232.137.71; verify the host before any change)
Socket events (server/calls/rcRelay.ts, wired in server/calls/index.ts):
* `rc:keys:publish` → PreKeyDirectory (identity change wipes OPKs; ≤200 OPKs).
* `rc:keys:fetch {callId[, userId]}` → bundles for every device of the *peer of a live call you are in* (server derives
  the peer; no scraping / OPK drain); consumes 1 OPK per device.
* `rc:msg {callId, env}` → membership, size (96 KB), rate (300/10 s), per-sender monotonic `n`; forwarded opaque.
* `rtc:iceConfig` unchanged: short-lived TURN creds = ICE transport (Signal also uses TURN), **not** the mediasoup ladder.

Historical planned replacement steps (superseded by current status below):
1. Persist PreKeyStore in Postgres (`rc_identity(user_id, ik_dh, ik_sig, spk_id, spk, spk_sig)`, `rc_opk(user_id, id, pub)`).
2. Stop routing calls through `media-sfu` (mediasoup PlainTransport) and `mediaBackend.ts`/`sfuSelect.ts`; delete those
   calling paths once all three clients ship `rc:msg` (old clients cannot interoperate — hard cut, no dual engine).
3. TURN: keep a TURN listener *as ICE relay* only (Signal uses TURN with short-lived creds). If "replace coturn" means
   no coturn binary at all, a clean-room TURN (e.g. pion/turn, MIT) on the same droplet is the drop-in; RingRTC's own
   relay servers are Signal-operated and not reproducible.
4. Remove LiveKit calling (server/livekit.ts calling uses, livekitIce) after cut.

## LICENSE-GATED (off; requires Donny's separate authorization + license review)
* Android: `org.signal:ringrtc-android:2.74.0` AAR — seam `RcMediaBackend` (Kotlin) would host it.
* iOS: SPM `SignalRingRTC` 2.74.0 / `webrtc-8037b` xcframework — seam `OLRcMediaBackend` protocol (Swift).
* libsignal (`libsignal-client`) — seam is the session interface (`OlSession` / `OLX3DHSession` / `OlX3dhSession`).
* Live now: interim BSD WebRTC M152 (already linked) + this clean-room session layer.

## Historical pre-hard-cut status (superseded)
* engine.ts still contains mediasoup/LiveKit/native-fallback branches; this branch seals the P2P path only. Deleting
  the legacy branches is the next Cos integration step (large, behavior-affecting).
* PJSIP still vendored on Android/iOS because video fan-out code depends on it; removal follows video move to WebRTC.
* Real-device matrix not run. No deploy, no /download, no store upload.

## Hard cut (ringrtc-bindings): one engine

- Web `engine.ts`: only `CallSession` (browser PC, sealed rc:* via `sealedFor`) or, in apps with `rtcP2P`, the app-owned
  PC through `NativeMediaSession` (relays rc:* / rtc:* only). mediasoup, LiveKit-for-calls and every native/TCP/relay
  fallback lane are deleted. LiveKit remains for audio rooms only.
- Server: `selectMedia` is p2p only; `ms:*`, `call:mediaFallback/Restore`, callq and SFU gates are gone; `rcRelay` stays.
  Nothing deployed.
- Android/iOS: PJSIP removed from the call path; camera video rides the same RingRTC-model PC.

## Historical TURN decision notes (superseded)

Signal still needs TURN: a meaningful share of 1:1 calls (symmetric NAT, UDP-blocked networks) only connect via a relay,
and RingRTC itself always offers relay candidates. This branch keeps the existing short-lived TURN REST credentials
(`mintTurnIceServers`, `TURN_STATIC_SECRET`, `call:turnRefresh` / `rtc:iceConfig`) and invents no TURN server.
Which server issues them — keep coturn on the droplet, or move to pion/turn — is Cos's decision; the client only
consumes `iceServers`, so either works without client changes.
