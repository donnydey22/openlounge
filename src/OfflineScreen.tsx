import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS } from './config';
import type { Theme } from './themeStore';

type Props = {
  theme: Theme;
  /** Manual nudge; retries also happen automatically (network comes back, backoff timer, app foreground). */
  onRetryNow: () => void;
  insets: { top: number; bottom: number };
};

/**
 * Calm, branded "can't reach Open Lounge" state: no error codes, no dialogs, quiet automatic retries.
 * Same wording as the Android wrapper (res/values/strings.xml offline_message).
 */
export function OfflineScreen({ theme, onRetryNow, insets }: Props) {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 280, delay: 120, useNativeDriver: true }).start();
  }, [fade]);

  const dark = theme !== 'light';
  const bg = dark ? COLORS.dark : COLORS.light;
  const text = dark ? COLORS.textDark : COLORS.textLight;
  const muted = dark ? COLORS.mutedDark : COLORS.mutedLight;

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}
      accessibilityRole="summary"
    >
      <Animated.View style={[styles.center, { opacity: fade }]}>
        <Image source={require('../assets/splash-icon.png')} style={styles.mark} accessibilityIgnoresInvertColors />
        <Text style={[styles.title, { color: text }]} accessibilityRole="header">
          Can’t reach Open Lounge right now
        </Text>
        <Text style={[styles.body, { color: muted }]}>We’ll keep trying — check your connection.</Text>
        <View style={styles.status}>
          <ActivityIndicator size="small" color={muted} />
          <Text style={[styles.statusText, { color: muted }]}>Reconnecting…</Text>
        </View>
        <Pressable
          onPress={onRetryNow}
          hitSlop={12}
          style={({ pressed }) => [styles.retry, pressed && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel="Try again now"
        >
          <Text style={styles.retryText}>Try now</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', paddingHorizontal: 36, maxWidth: 420 },
  mark: { width: 88, height: 88, marginBottom: 28 },
  title: { fontSize: 20, fontWeight: '600', textAlign: 'center', letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 10 },
  status: { flexDirection: 'row', alignItems: 'center', marginTop: 28, gap: 8 },
  statusText: { fontSize: 13 },
  retry: { marginTop: 18, paddingHorizontal: 20, paddingVertical: 8 },
  retryText: { color: COLORS.accent, fontSize: 16, fontWeight: '600' },
});
