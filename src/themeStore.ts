import * as SecureStore from 'expo-secure-store';

export type Theme = 'dark' | 'light';

// Last web theme, so the next launch paints the right background/status bar before the page reports it.
const KEY = 'openlounge.theme';
const OPTS: SecureStore.SecureStoreOptions = {
  keychainService: 'com.donnydey.openlounge.prefs',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadTheme(): Promise<Theme | null> {
  try {
    const v = await SecureStore.getItemAsync(KEY, OPTS);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

let last: Theme | null = null;
export function saveTheme(t: Theme): void {
  if (t === last) return;
  last = t;
  SecureStore.setItemAsync(KEY, t, OPTS).catch(() => {});
}
