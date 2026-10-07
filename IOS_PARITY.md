# Open Lounge iOS (Expo wrapper): parity checklist

Wrapper: Expo SDK 57.0.27 · RN 0.86.3 · react-native-webview 13.16.1 · `com.donnydey.openlounge` 0.2.3.
This round changed only the code in this repo. Nothing was built, and nothing contacted Expo or Apple.

Status key: **done** = in code and checked offline (config/prebuild/bundle/tests) · **device** = in code, but needs a
real iPhone to confirm · **blocked** = can't be finished from this repo (reason given).

## 1. Icons and splash
| Item | Status | Notes |
|---|---|---|
| App icon same as Android | **done** | `scripts/generate-assets.mjs` renders the Android adaptive icon from source (`res/drawable/ic_launcher_foreground.xml` on `openlounge_bg` #1C1C1E). It crops to the 72dp area Android launchers actually show, so the mark is the same size on both home screens. The output is 1024×1024 RGB with **no alpha**; checked in prebuild output `AppIcon.appiconset`. (The old Android `mipmap-*/ic_launcher.png` files are a different, pre-adaptive drawing. API 26+ launchers never show them.) |
| Splash same as Android, light/dark | **done** · device glance | The Android 12+ system splash is the icon masked to a circle on #1C1C1E. iOS: **dark** = #1C1C1E plus the same mark (the circle blends into the background, so it looks identical). **Light** = #F4F3EE (the web light theme) with the mark on its dark circle badge. Prebuild output checked: the `SplashScreenBackground` colorset has light and dark appearances, and the logo is 160pt with dark variants. |
| Regenerate | — | `npm run assets` (uses `sharp` from `/workspace/openlounge/node_modules`, a dev tool only and not an app dependency). |

## 2. Safe areas, status bar, launch
| Item | Status | Notes |
|---|---|---|
| Notch / Dynamic Island | **done** · device | The web headers don't pad with `env(safe-area-inset-top)`. Only AuthFlow and Toasts do; the app was built for Android's opaque status bar. So the WebView starts below the status bar, and that strip is painted in the page's theme colour. This matches Android, and `env(safe-area-inset-top)` is 0 in the page. Flip `EDGE_TO_EDGE_TOP` in `src/config.ts` once every header uses the inset. |
| Home indicator | **done** · device | The bottom stays edge to edge. `contentInsetAdjustmentBehavior="never"` and `automaticallyAdjust*Insets={false}` mean the page sees the real `env(safe-area-inset-bottom)`, which the room, home, DM and auth bars already use. |
| Status bar follows theme | **done** · device | The injected script watches `<html data-theme>` and sends `{method:'theme'}`. The app then sets the status bar (`light` on dark, `dark` on light), the root view colour (`expo-system-ui`) and the WebView background. The theme is saved in the Keychain, so the next launch starts in the right colours. At launch `UIStatusBarStyleDefault` follows system appearance, matching the light/dark splash. |
| No white flash | **done** · device | The native background, WebView background and container all use the theme colour (dark by default). The splash stays up until the page reports **ready**, then fades out over 280 ms. Ready means `OpenLoungeNative.ready()` or the auto-detect: the web app's AuthGate `[data-testid="splash"]` is gone and a frame has painted. Fallbacks: 1.5 s after `load`, or 8 s at most. Expected: a light-mode phone with the default dark web theme crossfades from the light splash to the dark app. That's intended, not a flash. |

## 3. Audio (LiveKit in WKWebView)
| Item | Status | Notes |
|---|---|---|
| Mic permission string | **done** | `NSMicrophoneUsageDescription` (checked in the generated Info.plist). |
| `UIBackgroundModes: audio` | **done** | Checked in Info.plist. Keeps the app alive in the background while WebKit's audio session is active (a room is playing). |
| Inline/autoplay | **done** | `allowsInlineMediaPlayback`, `mediaPlaybackRequiresUserAction={false}`, AirPlay allowed, PiP off. |
| No re-prompt every launch | **done** · device | `mediaCapturePermissionGrantType="grantIfSameHostElseDeny"`. getUserMedia is granted silently when the requesting origin's host is the page's host. Top-level pages can only be Open Lounge hosts, because other sites open in Safari. Cross-origin iframes are denied. iOS still asks for mic access once (system prompt), then never again. |
| playAndRecord, speaker by default, Bluetooth | **device** | WebKit owns `AVAudioSession` while a page captures the mic. It switches to `playAndRecord` with `defaultToSpeaker`, `allowBluetooth` (HFP), A2DP and AirPlay, and restores the session afterwards. A category set by the app would be overwritten, or would fight WebKit and interrupt other apps' audio at launch. So the wrapper deliberately sets nothing natively. **Test:** join a room as a speaker. Sound should come from the loudspeaker, not the earpiece. Switch to AirPods and back. **If audio goes to the earpiece:** add a small local Expo module (`modules/openlounge-audio`, Swift) that calls `overrideOutputAudioPort(.speaker)` on `routeChangeNotification` when the output is `.builtInReceiver`. This was left out on purpose because Swift can't be compiled on this box, and an uncompiled native module risks breaking the EAS build. |
| Recover after calls / backgrounding | **device** | On `inactive→active` (call, Siri, Control Center) and `background→active`, the app injects `audioResumeScript`. It resumes `suspended`/`interrupted` AudioContexts (the bridge records them with a Proxy construct trap, so `instanceof` and subclassing keep working; checked in WebKit) and restarts paused autoplay MediaStream `<audio>` elements, which are LiveKit's remote tracks. It then fires `openlounge:native-audio-resume`. It also fires `openlounge:native-visibility {visible}`, the same event Android sends, which `src/lib/realtime.ts` already uses to reconnect. Optional web hook: on `openlounge:native-audio-resume`, call `room.startAudio()`. |

## 4. Feel
| Item | Status | Notes |
|---|---|---|
| No rubber-band | **done** · device | `bounces={false}` plus injected `overscroll-behavior:none` on html/body. Inner lists keep their native bounce. |
| No pinch / double-tap / input zoom | **done** | The injected script adds `maximum-scale=1, user-scalable=no` to the viewport meta (WKWebView honours it), `touch-action:manipulation`, and blocks `gesturestart`. Checked in Playwright WebKit. |
| No long-press previews / callouts on chrome | **done** | `allowsLinkPreview={false}`. `a, img, svg, button, [role=button\|tab\|menuitem\|link], nav, header, label` get `-webkit-touch-callout:none; user-select:none`. Inputs, textareas, contenteditable and `[data-selectable]` stay selectable, and so does message text. No tap highlight. `dataDetectorTypes="none"`, so phone numbers aren't auto-linked. |
| Swipe-back = web history | **done** · device | `allowsBackForwardNavigationGestures`. Next.js `pushState` entries are in WKWebView's back/forward list. |
| Keyboard / chat composer | **done** · device | `keyboardDisplayRequiresUserAction={false}` (focus() opens the keyboard) and `hideKeyboardAccessoryView` (no ‹ › Done bar). The keyboard overlays the page as in Safari. The DM thread already follows `window.visualViewport`. The app also publishes `--ol-keyboard-height` and `openlounge:native-keyboard {visible,height,duration}`. To try an Android-style `adjustResize`, set `KEYBOARD_MODE='resize'` in `src/config.ts`; it only needs a device comparison. |
| Haptics bridge | **done** (bridge) · web hook not added | `OpenLoungeNative.haptic(kind)` is fire-and-forget and throttled to 60 ms. Mapping: `raiseHand` = light impact, `joinStage` = success notification, `sendDm` = soft impact. Also accepts `light`, `medium`, `heavy`, `soft`, `rigid`, `selection`, `success`, `warning`, `error`. The web repo was not touched. JS hook for the web team: `window.OpenLoungeNative?.haptic?.('raiseHand')`. Android doesn't have the method; optional chaining makes the call a no-op there. |

## 5. Links and sign-in
| Item | Status | Notes |
|---|---|---|
| External links → SFSafariViewController | **done** | Top-level navigations and `target=_blank` to other sites open in `WebBrowser.openBrowserAsync` (accent tint, "Done"). `mailto:`, `tel:`, `sms:` and `itms-apps:` go to iOS. Embedded iframes still load in place. |
| openlounge.app stays in-app | **done** | `openlounge.app`, `www.openlounge.app` and the Railway host. **Security fix:** host checks now use a strict parser (`src/url.ts`). The old check used RN's regex `URL` shim, which reads the host of `https://evil.example?@openlounge.app/` as `openlounge.app`. That would have let such a page into the app and onto the session bridge. Covered by `npm run test:bridge`. |
| `openlounge://` scheme | **done** | `scheme: "openlounge"` (checked in Info.plist `CFBundleURLTypes`). It needs no entitlement. `openlounge://room/abc` opens `https://openlounge.app/room/abc`. |
| Google/Apple via ASWebAuthenticationSession | **done** · blocked on server | Wired to the contract on the `unified-auth` branch (`server/authx/routes.ts`, `src/lib/authApi.ts`). The page calls `OpenLoungeNative.openAuth("…/auth/{google,apple}/start?app=1&cc=…")`, and the app opens `openAuthSessionAsync(url, "openlounge://auth")`. The server redirects to `openlounge://auth?code=…`, and the app loads `/auth/complete?code=…` on the same origin, so the PKCE verifier in localStorage matches. That page POSTs `/auth/exchange`. The handler also accepts `openlounge://auth/exchange?code=…`, `https://openlounge.app/auth/exchange?code=…` and `?error=…`, validates the code format, and drops duplicate codes. If an older web build navigates straight to `/auth/*/start?app=1`, the request is still caught and sent to the auth sheet. `canUseOAuth()` on the web turns true here because `openAuth` exists. **Blocked:** end-to-end test needs `unified-auth` deployed with Google/Apple credentials. |
| Universal links `applinks:openlounge.app` | **blocked** (prepared, off) | `OPENLOUNGE_UNIVERSAL_LINKS=1` (`app.config.ts`) adds `applinks:openlounge.app` and `applinks:www.openlounge.app`; checked with `expo config`. It's off by default for two reasons. (1) It adds the Associated Domains entitlement, so the next EAS build changes capabilities on the App ID and regenerates profiles. (2) It does nothing until the web serves `/.well-known/apple-app-site-association`, which is the web repo's job. To enable: serve the AASA below (`application/json`, no redirect), then add `"env": {"OPENLOUNGE_UNIVERSAL_LINKS": "1"}` to the eas.json profiles. |

AASA for the web team (replace `TEAMID`):
```json
{ "applinks": { "details": [ { "appIDs": ["TEAMID.com.donnydey.openlounge"], "components": [
  { "/": "/auth/*/start*", "exclude": true }, { "/": "/api/*", "exclude": true },
  { "/": "/room/*" }, { "/": "/profile/*" }, { "/": "/messages/*" }, { "/": "/auth/exchange*" }, { "/": "/auth/complete*" }
] } ] } }
```

## 6. Offline / neutral state
| Item | Status | Notes |
|---|---|---|
| Calm offline screen | **done** · device (airplane-mode launch) | Any main-frame load failure (except cancelled navigations and policy cancels) or a 5xx from the app host shows `src/OfflineScreen.tsx`. It's in the theme colours with the app mark, the same wording as Android ("Can't reach Open Lounge right now / We'll keep trying — check your connection."), "Reconnecting…" and a quiet "Try now". No dialogs and no error codes. The splash hides behind it. |
| Auto-retry | **done** | Retries back off 2→4→8→16→30 s. Retries also fire right away when the network path comes back (`expo-network` listener, debounced) and when the app returns to the foreground. The overlay stays until a load succeeds, so it doesn't flicker. |

## 7. Release config
| Item | Status | Notes |
|---|---|---|
| No dev menu / debug flags | **done** | No `expo-dev-client`, and both profiles set `developmentClient:false` with Release configuration. Release RN builds have no dev menu. `webviewDebuggingEnabled={__DEV__}` is false in the export bundle, and `networkInspector:false`. One template leftover: `NSAllowsLocalNetworking=true` (Expo template ATS default, harmless; `NSAllowsArbitraryLoads=false`). |
| `ITSAppUsesNonExemptEncryption=false` | **done** | Checked in the generated Info.plist. |
| Privacy manifest | **done** · check against App Store Connect | Required-reason APIs combined from every pod's PrivacyInfo: UserDefaults CA92.1; FileTimestamp C617.1/0A2A.1/3B52.1; SystemBootTime 35F9.1; DiskSpace E174.1/85F4.1. Tracking is false with no tracking domains. Collected types (linked, not used for tracking, app functionality): name, phone, email, user ID, photos (avatar), messages (DMs), other user content. Live audio is streamed, not stored, so it isn't listed. **The App Privacy answers in App Store Connect must match.** Checked in the generated `PrivacyInfo.xcprivacy`. |
| Build number auto-increment | **done** | `eas.json`: `appVersionSource: "remote"` and `autoIncrement: true` on preview and production. The first build seeds the counter from `ios.buildNumber` 6 (local autoIncrement can't safely write through `app.config.ts`). |
| iOS deployment target ≥ 16.4 | **done** | `ios.deploymentTarget: "16.4"`, checked in pbxproj (all 4 configs) and `Podfile.properties.json`. |

## Validation run on the box (no network to Expo/Apple)
Every Expo command ran inside `unshare -rn` (a network namespace with no network) with `EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1`.
- `npx tsc --noEmit`: clean.
- `npx expo config --type prebuild`: OK (with and without `OPENLOUNGE_UNIVERSAL_LINKS=1`).
- `npx expo prebuild --platform ios --no-install --clean` in a temp copy, using the npm-packed `expo-template-bare-minimum@57.0.29`: OK. Entitlements file is empty, and the Info.plist, PrivacyInfo, icon, splash and deployment target were checked by hand.
- `npx expo export --platform ios`: Hermes bundle builds (622 modules).
- `expo-doctor` 1.20.4: 19/21. The 2 failures need the network: the config-schema check (exp.host) and the React Native Directory check. Both were blocked on purpose.
- `npm run test:bridge`: URL policy, deep-link and auth mapping, bridge parsing (all pass).
- Injected script run in Playwright **WebKit**: API frozen; theme and auto-ready messages; viewport lock; CSS callouts; AudioContext tracking keeps subclasses working; resume script returns suspended contexts to running; request/response round trip.

## Device test script (first ad hoc build)
1. Cold launch in light and in dark mode: splash colours, no white frame, fade into the page; status bar text is readable.
2. Toggle the web theme in Settings: status bar and top strip follow; relaunch and it starts in that theme.
3. Join a room and go on stage: sound from the speaker; switch to AirPods, then a car or Bluetooth headset; the mic works.
4. Take a phone call during a room, hang up: audio comes back without rejoining. Lock the screen for 2 minutes: audio continues.
5. Pinch, double-tap, long-press a link or avatar: nothing happens. Swipe from the left edge: web back.
6. DM composer: the keyboard opens without a jump and without the accessory bar; send works.
7. Airplane mode, then cold launch: calm screen. Turn airplane mode off: it loads within about 2 s without a tap.
8. Tap an external link: SFSafariViewController; tap Done to come back.
9. Once `unified-auth` is deployed: Continue with Google, then Apple; the system sheet comes back signed in. Cancel leaves the sign-in screen as it was.
