# Open Lounge — iOS app (ad-hoc builds)

The iOS app is a minimal **native Swift** wrapper (no Capacitor, no CocoaPods, no npm step) that
loads the production web app in a `WKWebView` — the iOS twin of `android/` (MainActivity.java).

| | |
|---|---|
| Bundle ID | `com.donnydey.openlounge` |
| Display name | Open Lounge |
| Version | 0.2.2 (build 5) — `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in the Xcode project |
| Minimum iOS | 15.0, iPhone (runs in compatibility mode on iPad) |
| Loads | `https://openlounge-production.up.railway.app` (`OPENLOUNGE_START_URL` build setting) |
| Audio | self-hosted LiveKit over WebRTC inside WKWebView (no LiveKit Cloud / Twilio) |

## What's in `ios/`

```
ios/
  OpenLounge.xcodeproj/          Xcode project + shared "OpenLounge" scheme (no generator needed)
  OpenLounge/
    AppDelegate.swift            launches, activates the audio session
    SceneDelegate.swift          window + re-activates audio when the app comes back
    AudioSession.swift           AVAudioSession .playAndRecord + [.defaultToSpeaker, .allowBluetooth],
                                 re-activated after interruptions (calls, Siri, ...)
    WebViewController.swift      WKWebView: inline playback, no user gesture needed for media,
                                 mic permission auto-granted for the production origin
                                 (WKUIDelegate requestMediaCapturePermissionFor, iOS 15+),
                                 HTTP cache cleared + HTML fetched uncached on launch (like
                                 Android's LOAD_NO_CACHE), JS alert/confirm/prompt, external
                                 links (mailto:, tel:, other sites) open outside the app
    Info.plist                   NSMicrophoneUsageDescription, NSCameraUsageDescription (photo
                                 picker "Take Photo"), UIBackgroundModes=audio, scene manifest
    Assets.xcassets              AppIcon (1024px, rendered from the Android adaptive icon) and
                                 the launch background colour (#1C1C1E)
  devices.txt                    tester UDIDs for ad-hoc builds
  fastlane/Fastfile              `fastlane ios adhoc` — signing + IPA export with an API key
```

## How builds work (`.github/workflows/ios-adhoc.yml`)

Run it from GitHub → Actions → **iOS ad-hoc build** → *Run workflow* (or
`gh workflow run ios-adhoc.yml --ref <branch>`). It runs on `macos-latest`.

* **No Apple secrets yet → unsigned build.** `xcodebuild … CODE_SIGNING_ALLOWED=NO` for a generic
  iOS device, then checks the bundle (bundle id, version, URL, background audio, icon). It
  uploads `OpenLounge-unsigned.ipa` only as proof it compiles — **it cannot be installed**.
* **All four Apple secrets present → signed ad-hoc IPA.** fastlane, using only the App Store
  Connect API key (no Apple ID password / 2FA, no `match` repo):
  1. creates the App ID `com.donnydey.openlounge` if missing,
  2. registers every UDID in `ios/devices.txt` (+ the optional `devices` workflow input),
  3. gets an **Apple Distribution** certificate (`cert`),
  4. regenerates the **Ad Hoc** provisioning profile with all registered devices (`sigh --adhoc --force`),
  5. archives and exports `OpenLounge.ipa` → artifact **OpenLounge-adhoc-ipa** (kept 14 days).
* **`DIAWI_TOKEN` present → Diawi.** The signed IPA is uploaded to `https://upload.diawi.com/`
  and the install link is printed in the log and the run summary.

Cost: one job, typically a few minutes. On a private repo GitHub bills macOS minutes at 10×, so
don't run it on every push.

> Until this workflow file is on `main`, GitHub only lets it run via the temporary `push` trigger
> on the `ios-build` branch (manual "Run workflow" requires the file on the default branch).
> Remove the `push:` block when merging.

## What Donny needs to provide

### 1. App Store Connect API key (one-time)
Requires a paid Apple Developer Program membership (the account that owns the Team).

1. <https://appstoreconnect.apple.com/access/integrations/api> → **Team Keys** → **+**
   (the first time, the Account Holder must click *Request Access*).
2. Name it e.g. "GitHub CI", role **Admin** (or **App Manager**; Admin is safest because creating
   *distribution* certificates is restricted). Generate.
3. Note the **Issuer ID** (top of the page) and the **Key ID**; download the **`AuthKey_XXXXXXXXXX.p8`**
   file — Apple lets you download it **only once**.

### 2. Team ID
<https://developer.apple.com/account> → **Membership details** → *Team ID* (10 characters, e.g. `A1B2C3D4E5`).

### 3. GitHub secrets (repo → Settings → Secrets and variables → Actions)

| Secret | Value | Needed |
|---|---|---|
| `ASC_KEY_ID` | Key ID, e.g. `2X9R4HXF34` | signed build |
| `ASC_ISSUER_ID` | Issuer ID (UUID) | signed build |
| `ASC_KEY_P8` | full contents of the `.p8` file (`-----BEGIN PRIVATE KEY-----…`), or its base64 | signed build |
| `APPLE_TEAM_ID` | Team ID | signed build |
| `DIST_CERT_P12_PASSWORD` | any strong password you choose | strongly recommended (see below) |
| `DIST_CERT_P12_BASE64` | base64 of the exported distribution cert (see below) | after the first signed run |
| `DIAWI_TOKEN` | Diawi API token (diawi.com → profile → API access token) | optional |

With the gh CLI:

```bash
gh secret set ASC_KEY_ID      -R donnydey22/openlounge -b "2X9R4HXF34"
gh secret set ASC_ISSUER_ID   -R donnydey22/openlounge -b "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
gh secret set ASC_KEY_P8      -R donnydey22/openlounge < AuthKey_2X9R4HXF34.p8
gh secret set APPLE_TEAM_ID   -R donnydey22/openlounge -b "A1B2C3D4E5"
gh secret set DIST_CERT_P12_PASSWORD -R donnydey22/openlounge -b "$(openssl rand -base64 24)"   # keep a copy
gh secret set DIAWI_TOKEN     -R donnydey22/openlounge -b "…"                                   # optional
```

**Distribution certificate reuse.** A CI runner starts empty, and Apple only allows a few
distribution certificates per team. So on the first signed run (no `DIST_CERT_P12_BASE64` yet)
the workflow creates a new *Apple Distribution* certificate and, if `DIST_CERT_P12_PASSWORD` is
set, exports it (encrypted with that password) as a 1-day artifact **new-dist-cert**. Save it:

```bash
gh run download <run-id> -R donnydey22/openlounge -n new-dist-cert
base64 -i dist-cert.p12 | gh secret set DIST_CERT_P12_BASE64 -R donnydey22/openlounge
```

Later runs import it and reuse the same certificate. (Alternatively export an existing
"Apple Distribution" identity from Keychain Access on a Mac as a `.p12` and store that.) If a run
fails with "reached the maximum number of available Distribution certificates", revoke an unused
one at <https://developer.apple.com/account/resources/certificates/list> or provide its `.p12`.

### 4. Each tester iPhone's UDID
Add one line per device to `ios/devices.txt` (`<UDID>  <name>`), commit, and run the workflow — or
pass them in the `devices` input of a manual run.

How to find a UDID:
* **Mac + cable (most reliable):** plug the iPhone in, open **Finder**, select the iPhone in the
  sidebar, click the grey text under the device name until it shows *UDID*; right-click → Copy.
  (Apple Configurator or Xcode → Window → Devices and Simulators also show the "Identifier".)
* **Windows:** in iTunes/Apple Devices, click the *Serial Number* field until it shows the UDID.
* **No computer:** on the iPhone open a UDID-profile site in Safari (e.g. <https://get.udid.io> or
  <https://udid.tech>), install the temporary profile it offers (Settings → Profile Downloaded),
  and it shows the UDID; delete the profile afterwards. Diawi's "find by UDID" can do the same.

Modern iPhones have UDIDs like `00008110-000A1B2C3D4E801E` (25 chars); older ones are 40 hex chars.

## Apple's ad-hoc limits

* An ad-hoc IPA **installs only on devices whose UDIDs are in its provisioning profile.** Anyone
  else gets "Unable to install". No TestFlight review is involved, but no public distribution either.
* **100 devices per device type (iPhone, iPad, …) per membership year.** Removing a device does
  **not** free its slot until the membership renews (then you can prune the list once).
* **Adding a device requires a new build:** add the UDID → run the workflow → testers re-install
  from the new Diawi link (existing installs keep working).
* The ad-hoc **provisioning profile expires after 1 year** (or earlier if the distribution
  certificate is revoked or the membership lapses); after that the app won't launch until a new
  build is installed. The Apple Distribution certificate itself is also valid for 1 year.
* **Developer Mode (iOS 16+):** Apple requires Developer Mode to run `.ipa`-based (ad-hoc)
  apps. After installing from Diawi, the tester goes to **Settings → Privacy & Security →
  Developer Mode**, turns it on, restarts, and confirms. (The toggle only appears once an
  ad-hoc/development-signed app is on the phone.) TestFlight builds don't need this.

## Building locally (optional)

Open `ios/OpenLounge.xcodeproj` in Xcode 16+, select your team under *Signing & Capabilities*, and
run on a device or simulator. To point a build at another server, change the
`OPENLOUNGE_START_URL` build setting.
