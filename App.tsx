import * as Network from 'expo-network';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Keyboard, Linking, Platform, Share, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { LaunchOverlay } from './src/LaunchOverlay';
import { OfflineScreen } from './src/OfflineScreen';
import {
  audioResumeScript,
  injectedBeforeContentLoaded,
  keyboardScript,
  nativeEventScript,
  parseBridgeMessage,
  resolveScript,
} from './src/bridge';
import {
  APP_SCHEME,
  APP_VERSION,
  AUTH_CALLBACK,
  COLORS,
  EDGE_TO_EDGE_TOP,
  KEYBOARD_MODE,
  SPLASH_MAX_MS,
  START_URL,
  isAppUrl,
} from './src/config';
import { playHaptic } from './src/haptics';
import { readContactsForPage } from './src/contacts';
import { onNotificationOpen, onTokenRefresh, requestPushPermissionAndToken } from './src/push';
import { type LinkTarget, isNativeAuthStart, resolveIncomingLink } from './src/links';
import * as Session from './src/sessionStore';
import { type Theme, loadTheme, saveTheme } from './src/themeStore';
import { schemeOf } from './src/url';

// Keep the native splash (same artwork/colours as Android's launch screen) up until the page has painted and the
// web app finished its session check (OpenLoungeNative.ready() or the automatic AuthGate check in bridge.ts).
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ fade: false, duration: 0 }); // LaunchOverlay takes over seamlessly (same bg)

const themeColor = (t: Theme) => (t === 'light' ? COLORS.light : COLORS.dark);

// WebKit errors that are not "the page could not be loaded".
const IGNORED_LOAD_ERRORS = new Set([
  -999, // NSURLErrorCancelled: superseded navigation
  102, // WebKitErrorFrameLoadInterruptedByPolicyChange: we cancelled it in onShouldStartLoadWithRequest
  204, // WebKitErrorPlugInWillHandleLoad (media documents)
]);

function openInSafariView(url: string) {
  const s = schemeOf(url);
  if (s !== 'http' && s !== 'https') {
    Linking.openURL(url).catch(() => {});
    return;
  }
  WebBrowser.openBrowserAsync(url, {
    controlsColor: COLORS.accent,
    dismissButtonStyle: 'done',
    enableBarCollapsing: true,
  }).catch(() => {
    // another SFSafariViewController is already up, or the URL is unsupported → hand it to iOS
    Linking.openURL(url).catch(() => {});
  });
}

function Shell() {
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const [launchReady, setLaunchReady] = useState(false);
  const [theme, setThemeState] = useState<Theme>('dark'); // the web app defaults to dark
  const [offline, setOffline] = useState(false);
  const [webKey, setWebKey] = useState(0);
  const [sourceUri, setSourceUri] = useState(START_URL);
  const [kbHeight, setKbHeight] = useState(0);

  const injected = useMemo(() => injectedBeforeContentLoaded(Platform.OS, APP_VERSION), []);

  // ---- refs read from long-lived listeners ----
  const offlineRef = useRef(false);
  const everLoaded = useRef(false); // this WebView instance finished a successful main-frame load
  const navFailed = useRef(false);
  const currentUrl = useRef<string>(START_URL);
  const splashHidden = useRef(false);
  const retryAttempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authBusy = useRef(false);
  const handledCodes = useRef(new Set<string>());
  const appState = useRef<AppStateStatus>(AppState.currentState);

  const inject = useCallback((js: string) => webRef.current?.injectJavaScript(js), []);

  // ---------------- splash ----------------
  const hideSplash = useCallback(() => {
    if (splashHidden.current) return;
    splashHidden.current = true;
    setLaunchReady(true); // fades the wordmark overlay out; the native splash was already handed to it
  }, []);

  useEffect(() => {
    const t = setTimeout(hideSplash, SPLASH_MAX_MS);
    return () => clearTimeout(t);
  }, [hideSplash]);

  // ---------------- theme ----------------
  const themeFromWeb = useRef(false);
  const applyTheme = useCallback((t: Theme, fromWeb: boolean) => {
    if (fromWeb) themeFromWeb.current = true;
    else if (themeFromWeb.current) return; // the page already reported its (newer) theme
    setThemeState(t);
    SystemUI.setBackgroundColorAsync(themeColor(t)).catch(() => {});
    if (fromWeb) saveTheme(t);
  }, []);

  useEffect(() => {
    let alive = true;
    loadTheme().then((t) => {
      if (alive && t) applyTheme(t, false);
    });
    return () => {
      alive = false;
    };
  }, [applyTheme]);

  // ---------------- offline / retry ----------------
  const setOfflineBoth = useCallback((v: boolean) => {
    offlineRef.current = v;
    setOffline(v);
  }, []);

  const clearRetry = () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  };

  const lastRetryAt = useRef(0);
  const retryNow = useCallback(() => {
    clearRetry();
    lastRetryAt.current = Date.now();
    navFailed.current = false;
    if (everLoaded.current && webRef.current) webRef.current.reload();
    else setWebKey((k) => k + 1); // a never-loaded WKWebView has nothing to reload
  }, []);

  const scheduleRetry = useCallback(() => {
    clearRetry();
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(retryAttempt.current, 4));
    retryAttempt.current += 1;
    retryTimer.current = setTimeout(retryNow, delay);
  }, [retryNow]);

  const goOffline = useCallback(() => {
    navFailed.current = true;
    setOfflineBoth(true);
    scheduleRetry();
    hideSplash();
  }, [hideSplash, scheduleRetry, setOfflineBoth]);

  // Network comes back → retry immediately (NWPathMonitor via expo-network).
  useEffect(() => {
    const sub = Network.addNetworkStateListener((s) => {
      if (!offlineRef.current || s.isConnected === false || s.isInternetReachable === false) return;
      if (Date.now() - lastRetryAt.current < 1500) return; // path updates arrive in bursts
      retryNow();
    });
    return () => sub.remove();
  }, [retryNow]);

  useEffect(() => () => clearRetry(), []);

  // ---------------- navigation helpers ----------------
  const navigate = useCallback((url: string) => {
    if (!isAppUrl(url)) return;
    if (everLoaded.current && !offlineRef.current && webRef.current) {
      webRef.current.injectJavaScript(`location.assign(${JSON.stringify(url)});true;`);
    } else {
      currentUrl.current = url;
      everLoaded.current = false; // fresh WebView instance
      setSourceUri(url);
      setWebKey((k) => k + 1);
    }
  }, []);

  const openTarget = useCallback(
    (t: LinkTarget | null) => {
      if (!t) return;
      if (t.code) {
        if (handledCodes.current.has(t.code)) return; // same code via auth session + Linking
        handledCodes.current.add(t.code);
      }
      navigate(t.url);
    },
    [navigate],
  );

  const handleIncomingUrl = useCallback(
    (url: string | null) => {
      if (url) openTarget(resolveIncomingLink(url, currentUrl.current));
    },
    [openTarget],
  );

  // Google / Apple: ASWebAuthenticationSession, callback openlounge://auth?code=… → /auth/complete in the WebView.
  const runAuth = useCallback(
    async (startUrl: string) => {
      if (authBusy.current) return;
      authBusy.current = true;
      try {
        const res = await WebBrowser.openAuthSessionAsync(startUrl, AUTH_CALLBACK, { preferEphemeralSession: false });
        if (res.type === 'success' && res.url) openTarget(resolveIncomingLink(res.url, startUrl));
        // 'cancel' / 'dismiss': the user closed the sheet; the sign-in screen is still there.
      } catch {
        // ASWebAuthenticationSession could not start; the page's own error handling covers it.
      } finally {
        authBusy.current = false;
      }
    },
    [openTarget],
  );

  // ---------------- push ----------------
  const pushToken = useRef('');
  const deliverPushToken = useCallback(
    (t: string) => {
      if (!t) return;
      pushToken.current = t;
      const q = JSON.stringify(t);
      inject(`window.__olExpoPushToken=${q};window.__olPushToken&&window.__olPushToken(${q});true;`);
    },
    [inject],
  );
  useEffect(() => onTokenRefresh(deliverPushToken), [deliverPushToken]);
  // notification tap → open its deep link (/messages/<peer>, /room/<id>) in the WebView
  useEffect(() => onNotificationOpen((path) => navigate(new URL(path, START_URL).toString())), [navigate]);

  // Deep links: cold start + while running.
  useEffect(() => {
    Linking.getInitialURL()
      .then(handleIncomingUrl)
      .catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handleIncomingUrl(e.url));
    return () => sub.remove();
  }, [handleIncomingUrl]);

  // ---------------- app lifecycle: visibility + audio recovery ----------------
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appState.current;
      appState.current = next;
      if (next === 'background') {
        inject(nativeEventScript('openlounge:native-visibility', { visible: false }));
      } else if (next === 'active' && prev !== 'active') {
        // 'inactive' → 'active' covers phone calls, Siri, Control Center; 'background' → 'active' a real resume.
        inject(nativeEventScript('openlounge:native-visibility', { visible: true }));
        inject(audioResumeScript(prev === 'background' ? 'foreground' : 'interruption'));
        if (offlineRef.current) retryNow();
      }
    });
    return () => sub.remove();
  }, [inject, retryNow]);

  // ---------------- keyboard ----------------
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', (e) => {
      const h = e.endCoordinates.height;
      inject(keyboardScript(true, h, e.duration ?? 250));
      if (KEYBOARD_MODE === 'resize') setKbHeight(h);
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => {
      inject(keyboardScript(false, 0, e.duration ?? 250));
      if (KEYBOARD_MODE === 'resize') setKbHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [inject]);

  // ---------------- bridge ----------------
  const reply = useCallback(
    (id: string, ok: boolean, result?: unknown, err?: string) => inject(resolveScript(id, ok, result, err)),
    [inject],
  );

  const onMessage = useCallback(
    async (e: WebViewMessageEvent) => {
      // Only the Open Lounge origin may use the native bridge (frame URL, strict parser).
      if (!isAppUrl(e.nativeEvent.url)) return;
      const msg = parseBridgeMessage(e.nativeEvent.data);
      if (!msg) return;
      switch (msg.method) {
        case 'theme':
          applyTheme(msg.value, true);
          return;
        case 'ready':
          hideSplash();
          return;
        case 'haptic':
          playHaptic(msg.value);
          return;
        case 'openExternal':
          if (isAppUrl(msg.value)) navigate(msg.value);
          else openInSafariView(msg.value);
          return;
        case 'share':
          Share.share({ message: msg.value.text, url: msg.value.url }).catch(() => {});
          return;
        case 'requestContacts':
          readContactsForPage()
            .catch(() => JSON.stringify({ granted: false }))
            .then((json) => inject(`window.__olContacts&&window.__olContacts(${JSON.stringify(json)});true;`));
          return;
        case 'openAppSettings':
          Linking.openSettings().catch(() => {});
          return;
        case 'setBadge':
          // app-icon badge = total unread reported by the web app (0 clears)
          void Notifications.setBadgeCountAsync(msg.value).catch(() => {});
          return;
        case 'requestNotificationPermission':
          // the page calls this after sign-in; iOS shows its prompt once
          requestPushPermissionAndToken().then(deliverPushToken);
          return;
        case 'openAuth':
          if (!isNativeAuthStart(msg.value)) {
            reply(msg.id, false, null, 'openAuth: unsupported URL');
            return;
          }
          reply(msg.id, true, null); // the system sheet takes over; the result comes back as a navigation
          runAuth(msg.value);
          return;
      }
      try {
        if (msg.method === 'getSession') reply(msg.id, true, await Session.getSession());
        else if (msg.method === 'setSession') reply(msg.id, true, await Session.setSession(msg.value));
        else if (msg.method === 'clearSession') reply(msg.id, true, await Session.clearSession());
      } catch (err) {
        reply(msg.id, false, null, err instanceof Error ? err.message : String(err));
      }
    },
    [applyTheme, hideSplash, navigate, reply, runAuth, inject, deliverPushToken],
  );

  // ---------------- link policy ----------------
  const onShouldStartLoadWithRequest = useCallback(
    (req: ShouldStartLoadRequest) => {
      const { url } = req;
      const scheme = schemeOf(url);
      if (scheme === 'about' || scheme === 'blob' || scheme === 'data') return true;
      if (scheme === APP_SCHEME) {
        handleIncomingUrl(url);
        return false;
      }
      if (scheme === 'http' || scheme === 'https') {
        if (isAppUrl(url)) {
          if (req.isTopFrame !== false && isNativeAuthStart(url)) {
            runAuth(url); // Google/Apple refuse embedded WebViews
            return false;
          }
          return true;
        }
        // Sub-frames (embeds) may load anything; a top-level page on another site opens in SFSafariViewController.
        if (req.isTopFrame === false) return true;
        openInSafariView(url);
        return false;
      }
      // mailto:, tel:, sms:, itms-apps:, … → hand off to iOS.
      Linking.openURL(url).catch(() => {});
      return false;
    },
    [handleIncomingUrl, runAuth],
  );

  const onNavChange = useCallback((nav: WebViewNavigation) => {
    if (isAppUrl(nav.url)) currentUrl.current = nav.url;
  }, []);

  const bg = themeColor(theme);

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <StatusBar style={theme === 'light' ? 'dark' : 'light'} animated />
      <View
        style={[
          styles.root,
          { paddingTop: EDGE_TO_EDGE_TOP ? 0 : insets.top, paddingBottom: KEYBOARD_MODE === 'resize' ? kbHeight : 0 },
        ]}
      >
        <WebView
          key={webKey}
          ref={webRef}
          source={{ uri: sourceUri, headers: { 'Cache-Control': 'no-cache' } }}
          style={[styles.root, { backgroundColor: bg }]}
          containerStyle={{ backgroundColor: bg }}
          // Safe areas: no automatic insets; the page sees real env(safe-area-inset-*) values (bottom: home
          // indicator; top is 0 because the WebView starts below the status bar unless EDGE_TO_EDGE_TOP).
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          automaticallyAdjustsScrollIndicatorInsets={false}
          // Bridge
          injectedJavaScriptBeforeContentLoaded={injected}
          injectedJavaScriptForMainFrameOnly
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          onMessage={onMessage}
          // Audio rooms (LiveKit/WebRTC): WebKit itself runs AVAudioSession as playAndRecord with
          // defaultToSpeaker + Bluetooth (HFP/A2DP) + AirPlay while the mic is captured. Grant getUserMedia for
          // the page's own host only (openlounge.app), deny cross-origin frames, so WebKit never re-prompts.
          mediaCapturePermissionGrantType="grantIfSameHostElseDeny"
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsAirPlayForMediaPlayback
          allowsPictureInPictureMediaPlayback={false}
          // Persistent cookies/localStorage (default data store)
          sharedCookiesEnabled
          domStorageEnabled
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically
          setSupportMultipleWindows={false}
          // Feel
          allowsBackForwardNavigationGestures // edge swipe = web history back/forward
          allowsLinkPreview={false}
          bounces={false}
          overScrollMode="never"
          pullToRefreshEnabled={false}
          dataDetectorTypes="none"
          textInteractionEnabled
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          decelerationRate="normal"
          applicationNameForUserAgent={`OpenLoungeiOS/${APP_VERSION} OpenLoungeExpo/${APP_VERSION}`}
          webviewDebuggingEnabled={__DEV__}
          originWhitelist={['https://*', 'http://*', 'about:*', 'blob:*', 'data:*', `${APP_SCHEME}:*`]}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onOpenWindow={(e) => {
            const url = e.nativeEvent.targetUrl;
            if (isAppUrl(url)) navigate(url);
            else if (schemeOf(url) === APP_SCHEME) handleIncomingUrl(url);
            else openInSafariView(url);
          }}
          onNavigationStateChange={onNavChange}
          onLoadStart={() => {
            navFailed.current = false;
          }}
          onLoadEnd={() => {
            if (navFailed.current) return;
            everLoaded.current = true;
            retryAttempt.current = 0;
            clearRetry();
            if (offlineRef.current) setOfflineBoth(false);
            hideSplash(); // first page loaded → reveal (LaunchOverlay also self-caps at 1.5s)
          }}
          onError={(e) => {
            if (IGNORED_LOAD_ERRORS.has(e.nativeEvent.code)) return;
            goOffline(); // calm offline screen + quiet automatic retry, never a dialog or raw error text
          }}
          onHttpError={(e) => {
            if (e.nativeEvent.statusCode >= 500 && isAppUrl(e.nativeEvent.url)) goOffline();
          }}
          onContentProcessDidTerminate={() => webRef.current?.reload()}
          startInLoadingState={false}
        />
      </View>

      <LaunchOverlay ready={launchReady} theme={theme} onShown={() => SplashScreen.hideAsync().catch(() => {})} />
      {offline && <OfflineScreen theme={theme} onRetryNow={retryNow} insets={insets} />}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ backgroundColor: COLORS.dark }}>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
