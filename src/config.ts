import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as { startUrl?: string };

/** The page the app opens. */
export const START_URL = extra.startUrl ?? 'https://openlounge.app';

/**
 * Hosts that stay inside the app (and may talk to the native session bridge).
 * Everything else that is opened as a top-level page goes to Safari.
 */
export const APP_HOSTS = new Set([
  new URL(START_URL).host.toLowerCase(),
  'openlounge.app',
  'www.openlounge.app',
  'openlounge-production.up.railway.app',
]);

export const APP_VERSION = Constants.expoConfig?.version ?? '0';

/** Theme colours of the web app (src/lib/theme.ts THEME_COLORS) and the native launch background. */
export const COLORS = {
  launch: '#1C1C1E',
  dark: '#0b0b0d',
  light: '#f4f3ee',
  accent: '#F2B366',
};

export function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && APP_HOSTS.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}
