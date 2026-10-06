# Install Open Lounge on Android

**APK:** `openlounge.apk` (to be rebuilt under the Open Lounge name after the Railway deploy)  
**Type:** debug / sideload — **not** a Play Store–signed release  
**Package:** `com.donnydey.openlounge.debug` · Android 7.0+ (API 24)

The APK is a native WebView shell. It does **not** embed the Node server. Point it at your deployed **HTTPS** Open Lounge URL (Railway etc.). Soft rounded-hexagon avatars, signup, chat, and LiveKit audio all run in that web app.

## Install steps

1. Copy `openlounge.apk` to your phone (USB, Drive, email, …).
2. Open it from **Files** / **Downloads**.
3. If blocked: **Settings → Apps → Special app access → Install unknown apps** and allow the source app.
4. Tap **Install** → **Open**.
5. On first launch, paste your Railway HTTPS URL, e.g. `https://openlounge-production.up.railway.app`, then **Save & open**.
6. Allow **microphone** when prompted (live rooms / LiveKit).

Change the server later with the **gear** icon (top-right).

## Point at Railway + LiveKit (server)

On the **Railway** service (Node app), set:

```
LIVEKIT_URL=wss://<your-project>.livekit.cloud
LIVEKIT_API_KEY=<from LiveKit Cloud>
LIVEKIT_API_SECRET=<from LiveKit Cloud>
DATA_DIR=/data
SMS_PROVIDER=demo
```

- Create the LiveKit project at https://cloud.livekit.io → Settings → Keys.
- Mount a Railway volume at `/data`.
- Generate a Railway HTTPS domain (mic + **WSS** need TLS).
- Keep **one** replica (in-memory + JSON store).

Health check: `https://<domain>/api/health` → `{"ok":true,"audio":"livekit"}`.

In the APK, use that same `https://<domain>` as the server URL.

## Rebuild APK

```bash
cd android
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```
