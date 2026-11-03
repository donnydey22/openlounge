# Open Lounge PJSIP rebuild — design + milestones (phase 1, 2026-11-02 MST)

Pinned engine: pjproject **2.17** (tag, commit 5a45745). Branch `pjsip-rebuild` in donnydey22/openlounge, openlounge-ios (from ios-ship-026), openlounge-android (from main). Pre-branch heads recorded in backup-heads-20261102.txt.

## 1. Signaling over existing TLS WebSocket (no SIP server)
pjsua used as media engine only: SDP generated/consumed via pjmedia_sdp + pjmedia_transport_srtp (no SIP transport), or pjsua2 with a custom "WS-SIP" transport. Messages (JSON, existing WS auth):
- `call.invite {callId, from, to, sdp}` — offer SDP, m=audio RTP/SAVP, `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:<key>` (+ `a=crypto:2 AES_CM_128_HMAC_SHA1_32`), opus/48000/2, m=video H264 (AV1 when both sides advertise HW).
- `call.ringing {callId}`, `call.answer {callId, sdp}` — answer echoes exactly ONE crypto line with the chosen tag/suite (RFC 4568); `call.ice {callId, cand}` (trickle via coturn), `call.end {callId, reason}`, `call.stats {callId, rtpTx, rtpRx, srtpErr}`.
- Server: relays opaque SDP, never parses keys, never logs SDP bodies (keys redacted: `inline:<redacted>`). Adds VoIP push for iOS ring. TURN creds from existing coturn REST secret.
- pjmedia expectations: RTP/SAVP profile, srtp use=MANDATORY (`PJMEDIA_SRTP_MANDATORY`), keying SDES only (DTLS-SRTP disabled), key = base64 30-byte master key+salt; tag in answer must match offer tag.

## 2. Per-platform
- **iOS (Swift)**: pjproject.xcframework (CI macOS-14). CallKit only; Speakerbox: `provider.setConfiguration` before every `reportNewIncomingCall`; never call AVAudioSession.setActive; `pjsua_set_no_snd_dev()` at call setup, `pjsua_set_snd_dev()` in `provider(_:didActivate:)`, `pjsua_set_no_snd_dev()` in didDeactivate. Teardown on every end: hangup, destroy media transports, release snd dev. WebView = UI only (mic/camera permissions removed from WebView config).
- **Android (Kotlin)**: prefab AAR (`pjproject-2.17-prefab.aar`), ABIs arm64-v8a/armeabi-v7a/x86_64, NDK 27.2.12479018, APP_STL c++_shared, 16 KB pages. ConnectionService for ring; same teardown.
- **Web**: WASM Opus (libopus emscripten) + RTP/SRTP packetizer in WASM; getUserMedia for capture only (AudioWorklet), playback via AudioWorklet. Browsers can't send UDP → **ws-rtp relay** on droplet: Node/Go service on wss://relay.openlounge.app, authenticated by call token, maps each WS to a UDP socket, forwards SRTP packets unchanged (end-to-end SRTP, relay can't decrypt). Designed only, not deployed.
- **Video/simulcast**: H.264 via VideoToolbox/MediaCodec, AV1 only if HW encoder; 2-layer simulcast via coturn relay (note: coturn relays, it isn't an SFU — true simulcast for 1:1 = sender sends layers, receiver selects via `call.layer` message; group needs an SFU → decision for Donny).

## 3. Milestones
M1 (this turn) pjproject builds on CI for iOS + Android; SRTP SDES loopback on Linux. M2 iOS Swift wrapper + CallKit wiring. M3 Android Kotlin wrapper. M4 server WS messages (on branch). M5 two-way test Keiko Android → Donny iPhone, locked phone, redial <30 s ×5, pass = both sides RTP rx>0, srtpErr=0, audible. M6 web relay + WASM. M7 cutover.

## 4. Test plan
Unit: SDP crypto offer/answer parsing; CI loopback (`pjsip-srtp-loopback` workflow): two pjsua, `--use-srtp=2 --srtp-keying=0`, tones 440/880 Hz, both recordings RMS>0.05. Device: M5 checklist above.

## 5. Cutover / legacy removal
Done only after M5 passes and with Donny's direct confirmation: remove legacy call code on pjsip-rebuild branches; stop+disable mediasoup/LiveKit on droplet after config backup; coturn kept. (Requests to delete without backup were NOT executed — see report.)

## 6. Spec additions (Donny 11:42 PM)
1. **Keys in SDP only**: SRTP master keys are carried solely in `a=crypto` of the offer/answer (pjmedia transport_srtp SDES, `PJMEDIA_SRTP_KEYING_SDES` only, DTLS-SRTP off). No separate key-exchange message — `call.invite`/`call.answer` SDP is the key exchange. Verified pattern in CI loopback: offer lists 4 suites (AES_256_CM_HMAC_SHA1_80/32, AES_CM_128_HMAC_SHA1_80/32), answer echoes exactly one matching tag.
2. **iOS audio start gate** (Android→iPhone and all CallKit paths): in `provider(_:didActivate:)` assert `AVAudioSession.sharedInstance()` is active (didActivate is the confirmation; additionally check `secondaryAudioShouldBeSilencedHint`/route present), then `pjsua_set_snd_dev()`. Never call `setActive` anywhere. `didDeactivate` → `pjsua_set_no_snd_dev()` + full teardown.
3. **Adaptive jitter buffer (NetEQ-style, no WebRTC)**: NetEQ proper is WebRTC code (tgcalls embeds WebRTC) → forbidden. Use pjmedia_jbuf adaptive: `PJMEDIA_SOUND_BUFFER_COUNT` default, `jb_init=-1` (adaptive), `jb_min_pre=1`, `jb_max_pre=16` (≈320 ms @20 ms ptime), `jb_max=50`, `jb_discard_algo=PJMEDIA_JB_DISCARD_PROGRESSIVE`, Opus in-band FEC + PLC enabled (`PJMEDIA_HAS_OPUS_CODEC`, `no_vad=1`), set identically in pjsua_media_config on Swift and Kotlin wrappers (M2/M3).

## 7. Decisions (relayed 11:46 PM)
- pjproject 2.17 kept. Opus to be added to iOS/Android CI builds (libopus 1.5.x cross-built, `--with-opus`) — next step.
- Simulcast = 1:1 layered send (2 H.264 layers), receiver picks layer via `call.layer` WS message; media relayed by coturn. No SFU.
