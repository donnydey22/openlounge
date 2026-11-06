# Open Lounge calling — RingRTC session model + Signal-model relay (clean-room)

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

Replacement steps on the droplet (not executed — Cos approval required):
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

## Not yet done (honest)
* engine.ts still contains mediasoup/LiveKit/native-fallback branches; this branch seals the P2P path only. Deleting
  the legacy branches is the next Cos integration step (large, behavior-affecting).
* PJSIP still vendored on Android/iOS because video fan-out code depends on it; removal follows video move to WebRTC.
* Real-device matrix not run. No deploy, no /download, no store upload.
