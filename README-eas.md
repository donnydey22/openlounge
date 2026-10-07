# Open Lounge — Expo / EAS iOS build

Minimal Expo SDK 57 app (React Native 0.86, TypeScript) that full-screens `https://openlounge.app`
in `react-native-webview`, with a Keychain-backed session bridge. Native `ios/` is generated
(Continuous Native Generation) and git-ignored; EAS runs `expo prebuild` in the cloud.

| | |
|---|---|
| Bundle id | `com.donnydey.openlounge` (same as the Swift wrapper on branch `ios-build`) |
| Display name | Open Lounge |
| Version | 0.2.3 (build 6) — Swift wrapper was 0.2.2 (5), so this installs over it |
| Min iOS | 16.4 (Expo SDK 57) |
| Info.plist | NSMicrophoneUsageDescription, NSCamera/PhotoLibrary usage, UIBackgroundModes=[audio], ITSAppUsesNonExemptEncryption=false, no Face ID key |
| Entitlements | none (no push, no associated domains, no app groups) |
| EAS profiles | `preview` = internal (ad hoc, Release); `production` = store (Release) |

## Native bridge contract

```ts
window.OpenLoungeNative = {
  getSession(): Promise<string | null>
  setSession(json: string): Promise<void>
  clearSession(): Promise<void>
}  // plus read-only __expo: true, platform: 'ios', version: '0.2.3'
```

* Defined by `injectedJavaScriptBeforeContentLoaded` (main frame only) before any page script runs;
  the property is non-writable/frozen.
* Each call posts `{"__ol":1,"id":"ol<ts>_<n>","method":"getSession|setSession|clearSession","value"?}` via
  `window.ReactNativeWebView.postMessage`; the app answers with
  `window.__openLoungeNativeResolve(id, ok, result, error)` via `injectJavaScript`. 10 s timeout → reject.
* Only pages on `https://openlounge.app`, `www.openlounge.app`, `openlounge-production.up.railway.app`
  get answers (others are ignored → web times out → treats it as "no native store").
* Storage: `expo-secure-store` (Keychain service `com.donnydey.openlounge.session`,
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), value stored verbatim, chunked at 1800 chars,
  operations serialized. `setSession('')` = `clearSession()`.
* Optional page → app message `{"__ol":1,"method":"theme","value":"dark"|"light"}` is sent automatically
  from `<html data-theme>` changes; status bar = light text on dark theme, dark text on light theme.

## Apple-account safety rules (the team has other live apps)

* Only App ID touched: **`com.donnydey.openlounge`** (explicit, no wildcard). Do not change the bundle id.
  The app has no entitlements, so EAS capability sync has nothing to enable on any App ID.
* **Never revoke or replace** existing distribution certificates, push keys or provisioning profiles
  of other apps. If EAS shows `Select certificates to revoke.` → select **nothing** and press Enter,
  or Ctrl-C and stop.
* **Reuse an existing Apple Distribution certificate** (certificates are team-wide, not per app):
  * If the cert is already stored in this Expo account (other apps built with EAS), `eas build` asks
    `Reuse this distribution certificate?` → **Y**.
    If it asks `Select the iOS distribution certificate to use for code signing:` choose
    **[Choose another existing certificate] (Recommended)**, never **[Add a new certificate]**.
  * If no cert is stored in Expo yet, EAS asks `Generate a new Apple Distribution Certificate?` (default Y)
    → answer **n**, then `Path to P12 file:`, `P12 password:`, `Apple Team ID:` with an exported existing
    Apple Distribution cert (.p12). Only answer Y if Donny explicitly accepts a new cert (Apple allows 3).
* Push: `cli.promptToConfigurePushNotifications=false` in eas.json → no push-key prompt.
  If `Reuse this Push Key?` / `Would you like to set up Push Notifications` ever appears → **No**.
* Ad hoc profile: EAS creates one profile for `com.donnydey.openlounge` only.
  `Select devices for the ad hoc build:` → tick **Donny Dev (00008110-000E7DD63C03801E)**.
  `Would you like to reuse the profile?` → **Yes** if Donny Dev is in it.

## Commands (after the env file is filled in: `source ~/.openlounge-eas.env`)

```bash
cd /workspace/openlounge-expo
eas whoami                                   # proves EXPO_TOKEN works
eas init --non-interactive --force           # creates/links the EAS project, writes extra.eas.projectId + owner
git commit -am "Link EAS project"
eas device:create                            # interactive: "Developer Portal" → import Donny Dev (already on Apple portal)
eas device:list
eas credentials -p ios                       # optional pre-step: preview profile → Build Credentials → set up (same prompts as below)
eas build -p ios --profile preview           # FIRST build must be interactive (TTY); ASC key = no Apple ID/2FA
# later builds can be fully non-interactive:
eas build -p ios --profile preview --non-interactive --refresh-ad-hoc-provisioning-profile
```
