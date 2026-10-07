import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { injectedBeforeContentLoaded, parseBridgeMessage, resolveScript } from './src/bridge';
import { APP_VERSION, COLORS, START_URL, isAppUrl } from './src/config';
import * as Session from './src/sessionStore';

SplashScreen.preventAutoHideAsync().catch(() => {});

type Theme = 'dark' | 'light';

function openExternally(url: string) {
  Linking.openURL(url).catch(() => {});
}

function Shell() {
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const [theme, setTheme] = useState<Theme>('dark'); // the web app defaults to dark
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const injected = useMemo(() => injectedBeforeContentLoaded(Platform.OS, APP_VERSION), []);

  const hideSplash = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  // Never leave the splash up forever (offline, slow network): the error/loading UI takes over.
  useEffect(() => {
    const t = setTimeout(hideSplash, 8000);
    return () => clearTimeout(t);
  }, [hideSplash]);

  const reply = useCallback((id: string, ok: boolean, result?: unknown, err?: string) => {
    webRef.current?.injectJavaScript(resolveScript(id, ok, result, err));
  }, []);

  const onMessage = useCallback(
    async (e: WebViewMessageEvent) => {
      // Only the Open Lounge origin may use the native session store.
      if (!isAppUrl(e.nativeEvent.url)) return;
      const msg = parseBridgeMessage(e.nativeEvent.data);
      if (!msg) return;
      if (msg.method === 'theme') {
        setTheme(msg.value);
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
    [reply],
  );

  const onShouldStartLoadWithRequest = useCallback((req: ShouldStartLoadRequest) => {
    const { url } = req;
    const scheme = url.split(':', 1)[0].toLowerCase();
    if (scheme === 'about' || scheme === 'blob' || scheme === 'data') return true;
    if (scheme === 'http' || scheme === 'https') {
      if (isAppUrl(url)) return true;
      // Sub-frames (embeds) may load anything; a top-level page on another site opens in Safari.
      if (req.isTopFrame === false) return true;
      openExternally(url);
      return false;
    }
    // mailto:, tel:, sms:, itms-apps:, ... → hand off to iOS.
    openExternally(url);
    return false;
  }, []);

  const onNavChange = useCallback((nav: WebViewNavigation) => {
    if (!nav.loading && isAppUrl(nav.url)) setError(null);
  }, []);

  const retry = useCallback(() => {
    setError(null);
    if (loaded) webRef.current?.reload();
    else setReloadKey((k) => k + 1);
  }, [loaded]);

  const bg = theme === 'light' ? COLORS.light : COLORS.dark;

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <StatusBar style={theme === 'light' ? 'dark' : 'light'} animated />
      <WebView
        key={reloadKey}
        ref={webRef}
        source={{ uri: START_URL, headers: { 'Cache-Control': 'no-cache' } }}
        style={[styles.web, { backgroundColor: bg }]}
        containerStyle={{ backgroundColor: bg }}
        // Edge to edge: the site uses viewport-fit=cover + env(safe-area-inset-*) for its own padding.
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        // Session bridge
        injectedJavaScriptBeforeContentLoaded={injected}
        injectedJavaScriptForMainFrameOnly
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onMessage={onMessage}
        // Audio rooms
        mediaCapturePermissionGrantType="grant"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsAirPlayForMediaPlayback
        // Persistent cookies/localStorage (default data store)
        sharedCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        javaScriptCanOpenWindowsAutomatically
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        allowsLinkPreview={false}
        bounces={false}
        overScrollMode="never"
        pullToRefreshEnabled={false}
        textInteractionEnabled
        applicationNameForUserAgent={`OpenLoungeiOS/${APP_VERSION} OpenLoungeExpo/${APP_VERSION}`}
        webviewDebuggingEnabled={__DEV__}
        originWhitelist={['https://*', 'http://*', 'about:*', 'blob:*', 'data:*', 'mailto:*', 'tel:*', 'sms:*']}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onOpenWindow={(e) => {
          const url = e.nativeEvent.targetUrl;
          if (isAppUrl(url)) webRef.current?.injectJavaScript(`location.href=${JSON.stringify(url)};true;`);
          else openExternally(url);
        }}
        onNavigationStateChange={onNavChange}
        onLoadEnd={() => {
          setLoaded(true);
          hideSplash();
        }}
        onError={(e) => {
          const d = e.nativeEvent;
          if (d.code === -999) return; // NSURLErrorCancelled: superseded navigation
          setError(d.description || 'Network error');
          hideSplash();
        }}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500 && isAppUrl(e.nativeEvent.url) && !loaded) {
            setError(`Server error (${e.nativeEvent.statusCode})`);
          }
        }}
        onContentProcessDidTerminate={() => webRef.current?.reload()}
        startInLoadingState={false}
      />

      {!loaded && !error && (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator size="large" color={COLORS.accent} />
        </View>
      )}

      {error && (
        <View
          style={[
            StyleSheet.absoluteFill,
            styles.center,
            { backgroundColor: COLORS.launch, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
          ]}
        >
          <Text style={styles.errorText}>
            Could not load Open Lounge.{'\n\n'}
            {error}
            {'\n\n'}Check your internet connection and try again.
          </Text>
          <Pressable onPress={retry} style={styles.retry} accessibilityRole="button">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider style={{ backgroundColor: COLORS.launch }}>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  errorText: { color: '#fff', fontSize: 16, lineHeight: 22, textAlign: 'center' },
  retry: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 10 },
  retryText: { color: COLORS.accent, fontSize: 17, fontWeight: '600' },
});
