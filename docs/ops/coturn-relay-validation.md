# coturn relay validation plan

> **Status:** review-only. Do not set `TURN_STATIC_SECRET`, change Railway, alter coturn, or deploy this branch until Chief of Staff approves the pull request and a separate staging/release change.

This plan validates the optional external coturn service for **authenticated 1:1 calls**. It does not claim that Railway's current force-TCP LiveKit SFU has become UDP-capable. The test must prove the selected candidate path; a successful TURN allocation alone is not proof of end-to-end media relay.

## Configuration contract

When the app server has a non-empty server-only `TURN_STATIC_SECRET`:

- The call server creates a fresh coturn REST username in the form `<unix-expiry>:call-<opaque-id>` for each live call participant. The expiry defaults to 6 hours (`TURN_CREDENTIAL_TTL_S`, clamped 10 min to 24 h) so coturn allocation refreshes keep working for long calls.
- The opaque suffix is HMAC-derived from the call and user identifiers; neither identifier nor the static secret is sent in the ICE payload.
- The credential is `base64(HMAC-SHA1(TURN_STATIC_SECRET, username))`, compatible with coturn `use-auth-secret`.
- An authenticated `call:start`, `call:accept`, or `call:get` response for a live participant includes only these URLs:
  1. `turn:turn.openlounge.app:3478?transport=udp`
  2. `turn:turn.openlounge.app:3478?transport=tcp`
  3. `turns:turn.openlounge.app:443?transport=tcp`
- `TURN_STATIC_SECRET` is never sent, logged, committed, or prefixed with `NEXT_PUBLIC_`.
- If the variable is unset, `iceServers: []` remains explicit and the existing LiveKit/Railway TCP connection behavior is unchanged.

## Preflight — Chief of Staff only

1. Confirm coturn is still healthy and the deployed `use-auth-secret` value matches the value that will be placed **only** in the Open Lounge server environment.
2. Use a staging/review deployment or another explicitly approved release target. Do not modify the current Railway production configuration under this PR.
3. Add `TURN_STATIC_SECRET` through the platform's secret manager; do not paste it into a source file, shell history, browser console, issue, pull-request text, or chat.
4. Verify the deployed server has the variable without printing it. Start one signed-in test call and inspect its WebSocket response in browser DevTools:
   - it contains the three approved TURN URLs;
   - its username matches `^\d{10}:call-[A-Za-z0-9_-]{32}$`;
   - it does not contain `TURN_STATIC_SECRET`, a user ID, or a call ID.
5. With the variable absent on an isolated review deployment, repeat the same call and verify that the `iceServers` property is absent from call media and audio still uses the current LiveKit/TCP path.

## Forced-relay browser test

Run this in a **disposable desktop test tab** before starting a test call. It changes only that tab's newly created peer connections; refresh the tab to remove it. Do not use it in a normal user session.

1. Sign in two dedicated test accounts. Open the caller in a Chromium desktop browser and the callee in a second browser/device.
2. Open DevTools **Console** in the caller tab and run this snippet before pressing Call:

```js
(() => {
  const Native = window.RTCPeerConnection;
  if (!Native) throw new Error("RTCPeerConnection is unavailable");
  if (window.__olNativeRTCPeerConnection) return console.info("relay-only patch already active");

  function RelayOnlyRTCPeerConnection(configuration, ...args) {
    return new Native({ ...configuration, iceTransportPolicy: "relay" }, ...args);
  }
  RelayOnlyRTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(RelayOnlyRTCPeerConnection, Native);
  window.__olNativeRTCPeerConnection = Native;
  window.RTCPeerConnection = RelayOnlyRTCPeerConnection;
  console.info("Open Lounge test tab is forcing relay candidates");
})();
```

3. Start an audio call from the patched caller, accept it, and keep both directions speaking for at least 60 seconds. Repeat once with video enabled.
4. Open `chrome://webrtc-internals` on the patched caller and save the dump. The selected candidate pair must show a **local candidate type of `relay`** and continuously increasing sent/received RTP byte counters for the call.
5. Record only these non-secret facts: browser/version, network type, call direction, audio/video outcome, selected candidate types/transports, reconnect outcome, and the timestamp. Do **not** attach TURN usernames or credentials to tickets.
6. If the call fails or the selected pair is not relay, treat that as a failed architectural validation — not as a reason to weaken firewall, credentials, or auth. Capture the sanitized WebRTC dump and stop. The known Railway force-TCP limitation may prevent a usable relay pair; this test determines that rather than assuming success.

## iPhone and Android end-to-end checks — Donny

After Chief of Staff has confirmed the staging environment and completed the forced-relay browser check:

1. Use dedicated signed-in accounts on an iPhone and an Android device. Make audio calls in both directions, then video calls in both directions.
2. Test each pair on Wi-Fi and cellular when available. Confirm ringing, accept, two-way audio, speaker routing, mute/unmute, camera swap, self-preview framing, and hangup.
3. During one active audio call, switch Wi-Fi to cellular (or briefly disable/restore the active network) and confirm the reconnect UI appears and the call resumes or ends with the documented connection-lost state rather than becoming silently stuck.
4. Keep each successful call live for at least 60 seconds. Record device model/OS, app build, network, direction, and pass/fail. Do not capture credentials or personal-call content.

## Acceptance and rollback

- **Pass:** a forced-relay desktop call has a selected relay pair with two-way media; normal iPhone/Android calls pass the checks above; no client payload or log exposes the static secret.
- **Fail / hold:** no relay candidate is selected, relay media does not flow, any call regresses without `TURN_STATIC_SECRET`, or a secret is exposed. Do not deploy the feature.
- **Rollback:** remove `TURN_STATIC_SECRET` from the application environment and redeploy/restart the approved app target. The code then omits TURN configuration and returns to the explicit empty-ICE/TCP behavior; no coturn or database change is required.
