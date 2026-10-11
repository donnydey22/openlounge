# TURN relay staging and device checklist

> **Scope:** staging only. This checklist must not be run against `openlounge.app` or another production host. It does not set `TURN_STATIC_SECRET`, change coturn, deploy an app, or merge a pull request.

The automated probe verifies a real, forced-relay WebRTC data-channel round trip from the supplied staging origin. Both probe peers use `iceTransportPolicy: "relay"`; the selected candidate pair must be relay/relay. This proves that the short-lived coturn credential can allocate and carry peer traffic. It does **not** by itself prove that Railway's current LiveKit SFU has a usable relay path, so follow it with the app and device checks below.

## Required staging inputs

Chief of Staff supplies these values through the test shell or approved CI secret store. Never commit, paste into a ticket, or print the credential values.

| Variable | Purpose |
|---|---|
| `TURN_RELAY_TEST_STAGING_URL` | Exact HTTPS staging page URL, such as `https://review.example.test/`. |
| `TURN_RELAY_TEST_ALLOWED_HOST` | Exact hostname of that staging URL. The harness rejects a different host and known production hosts. |
| `TURN_RELAY_TEST_URLS` | Comma-separated credential-free `turn:` / `turns:` URLs. |
| `TURN_RELAY_TEST_USERNAME` | Fresh coturn REST username in `<unix-expiry>:<opaque-id>` form, valid for 30 seconds to 15 minutes. |
| `TURN_RELAY_TEST_CREDENTIAL` | Corresponding short-lived coturn REST HMAC credential. |
| `TURN_RELAY_TEST_BROWSER` | Optional: `chromium` (default), `firefox`, or `webkit`. |
| `TURN_RELAY_TEST_TIMEOUT_MS` | Optional: 5000–120000; default 45000. |

`TURN_STATIC_SECRET` is deliberately **not** an input to this harness.

## Automated forced-relay probe

1. On a disposable staging runner, install the browser runtime once:

   ```bash
   npx playwright install chromium firefox webkit
   ```

2. Mint a new short-lived credential through the approved server-side procedure. Do not use the static coturn secret in the test shell.
3. Supply the staging-only variables and run:

   ```bash
   TURN_RELAY_TEST_STAGING_URL='https://<approved-staging-host>/' \
   TURN_RELAY_TEST_ALLOWED_HOST='<approved-staging-host>' \
   TURN_RELAY_TEST_URLS='turn:turn.openlounge.app:3478?transport=udp,turn:turn.openlounge.app:3478?transport=tcp,turns:turn.openlounge.app:443?transport=tcp' \
   TURN_RELAY_TEST_USERNAME='<short-lived-rest-username>' \
   TURN_RELAY_TEST_CREDENTIAL='<short-lived-rest-credential>' \
   TURN_RELAY_TEST_BROWSER=chromium \
   npm run test:turn:relay
   ```

4. The only acceptable success output is a sanitized JSON summary with `status: "passed"`, relay candidates for both peers, and a selected `relay`/`relay` candidate pair. The harness prints no username or credential.
5. Repeat for `firefox` and `webkit` where the runner supports those browsers. A failure is a release hold: retain only sanitized browser logs and stop rather than relaxing firewall, CORS, credential lifetime, or auth.

The harness refuses to run without an explicit allowlisted staging host, against the known production hosts (`openlounge.app`, `www.openlounge.app`, and `openlounge-production.up.railway.app`), with non-HTTPS targets, with non-TURN URLs, or with credentials that are expired, too close to expiry, or longer-lived than 15 minutes.

## Open Lounge call checks after the probe passes

Use two dedicated staging accounts. In a disposable desktop caller tab, open DevTools **Console** before initiating the call and run this tab-local patch:

```js
(() => {
  const Native = window.RTCPeerConnection;
  if (!Native) throw new Error("RTCPeerConnection is unavailable");
  if (window.__olNativeRTCPeerConnection) return;

  function RelayOnlyRTCPeerConnection(configuration, ...args) {
    return new Native({ ...configuration, iceTransportPolicy: "relay" }, ...args);
  }
  RelayOnlyRTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(RelayOnlyRTCPeerConnection, Native);
  window.__olNativeRTCPeerConnection = Native;
  window.RTCPeerConnection = RelayOnlyRTCPeerConnection;
})();
```

Start one audio call and one video call in each direction. Confirm in `chrome://webrtc-internals` that the caller selects a relay candidate pair and that RTP bytes increase in both directions. Refreshing the tab removes the patch. If Railway's current TCP-only SFU path cannot form a usable relay pair, record the sanitized failure and hold the rollout; do not weaken the network or credential controls.

## Browser, device, and viewport checklist

For every row, test both audio and video calls with dedicated staging accounts. Confirm: call setup, ring/accept, two-way audio, mute/unmute, speaker routing, hangup, camera toggle, camera swap, self-view framing, and no clipped/overlapping controls. Keep each successful call active for at least 60 seconds.

| Platform / browser | 375 px | 412 px | 820 px | 1280 px |
|---|---:|---:|---:|---:|
| Desktop Chrome | ☐ | ☐ | ☐ | ☐ |
| Desktop Safari (macOS) | ☐ | ☐ | ☐ | ☐ |
| Desktop Firefox | ☐ | ☐ | ☐ | ☐ |
| iPhone Safari / Open Lounge iOS wrapper if applicable | ☐ | ☐ | ☐ | ☐ |
| Android Chrome / Open Lounge Android WebView | ☐ | ☐ | ☐ | ☐ |

Use representative heights while preserving each width: 375×812, 412×915, 820×1180, and 1280×800. On physical phones, test the closest available device width and record the actual model, OS, browser or WebView version, network (Wi-Fi/cellular), direction, viewport, and pass/fail. Capture no user content, TURN usernames, or credentials.

During one successful audio call on each physical platform, switch Wi-Fi to cellular or briefly interrupt and restore the network. Confirm the reconnect state appears and the call either resumes with two-way media or ends in the documented connection-lost state; it must not remain silently connected.

## Acceptance and rollback

- **Accept staging:** all three browser probes that are available in the staging runner pass; the selected desktop app candidate is relay; and the device matrix has no call, audio, video, self-view, or layout regression.
- **Hold:** a relay pair is absent, a data channel/RTP flow fails, the app falls back silently while marked connected, a viewport clips call controls, or any secret appears in output.
- **Rollback:** remove `TURN_STATIC_SECRET` from the approved app environment and restart/redeploy that approved target. The application returns to its explicit empty-ICE/LiveKit-TCP behavior without a database or coturn change.
