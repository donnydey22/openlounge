# Premium custom app icons — native shell spec

Open Lounge Premium members can pick an app icon on `/premium` (web). The web app swaps the tab icon and
home-screen icon itself. The Android and iOS WebView shells switch the launcher icon when the page asks them to.
Nothing here sells anything: the shells only *apply* an icon the account already has. There are no purchase screens or
links in the apps.

## Icons

| id        | name     | Premium |
|-----------|----------|---------|
| `classic` | Classic  | no (default) |
| `midnight`| Midnight | yes |
| `sunset`  | Sunset   | yes |
| `ocean`   | Ocean    | yes |
| `gold`    | Gold     | yes |
| `mono`    | Mono     | yes |

Source art: `public/app-icons/<id>.svg` (same mark as `src/app/icon.svg`, recoloured). 1024 px masters for the
shells: `node scripts/premium/build-app-icons.mjs --native` (writes `public/app-icons/<id>-1024.png`; don't commit
those, copy them into the shell projects).

## Bridge message

The page calls one of these, using whichever the shell exposes (feature-detected, so older shells ignore it):

1. `window.OpenLoungeNative.setAppIcon(name: string)` (preferred)
2. `window.OpenLoungeNative.postMessage(JSON.stringify({ type: "setAppIcon", name }))` (iOS React Native WebView fallback)

`name` is an icon id from the table, or `""` / `null` for `classic` (the primary icon).

The shell should:
- ignore unknown names;
- not prompt or navigate;
- remember nothing itself. The web app sends the current choice again on the next visit to `/premium`. If membership
  lapses, it sends `classic`.

## iOS (Expo / React Native, or a native wrapper)

- Add alternate icons under `CFBundleIcons → CFBundleAlternateIcons` in Info.plist, one entry per id
  (`midnight`, `sunset`, …). With Expo, use the `expo-alternate-app-icons` config plugin or set the plist directly.
- On a message: `UIApplication.shared.setAlternateIconName(name == "" ? nil : name)`.
  iOS shows its own "You have changed the icon" alert. That is expected and can't be suppressed.
- `supportsAlternateIcons` false → no-op.

## Android

- Declare one `<activity-alias>` per icon in AndroidManifest.xml. Each alias targets the main activity, has
  `android:icon="@mipmap/ic_launcher_<id>"`, and has the LAUNCHER intent filter. Only `classic` is enabled by
  default.
- On a message: `PackageManager.setComponentEnabledSetting` enables the chosen alias with
  `COMPONENT_ENABLED_STATE_ENABLED` and disables the others with `DONT_KILL_APP`. Some launchers take a few seconds to
  refresh.
- Adaptive icon layers: generate them from the 1024 masters (foreground = mark, background = gradient).

## Store notes

- Apple allows alternate icons (Guideline 4.5.2 is unrelated, and 2.3.5 doesn't apply). The icon has to be applied
  in response to a user action (the tap on `/premium` counts), and every alternate icon has to be included in the app
  review build.
- Premium is not sold in the apps. If the shell ever lists icons natively, show them as Premium perks without any
  price, buy button or external purchase link (App Store 3.1.1 / 3.1.3, Google Play Payments policy).
