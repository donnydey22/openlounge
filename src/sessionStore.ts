import * as SecureStore from 'expo-secure-store';

// Keychain-backed storage for the web app's opaque session string (see bridge.ts for the contract).
// Values are chunked because some iOS releases reject Keychain items above ~2 KB
// (https://docs.expo.dev/versions/latest/sdk/securestore/).

const PREFIX = 'openlounge.session';
const COUNT_KEY = `${PREFIX}.n`;
const CHUNK = 1800;
const MAX_CHUNKS = 64;

const OPTS: SecureStore.SecureStoreOptions = {
  keychainService: 'com.donnydey.openlounge.session',
  // Readable after the first unlock so token refresh keeps working while a room plays in the background
  // with the screen locked. Not synced/migrated off the device.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Serialize all Keychain operations so a stale write can never land after a newer one.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function readCount(): Promise<number> {
  const raw = await SecureStore.getItemAsync(COUNT_KEY, OPTS);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 && n <= MAX_CHUNKS ? n : 0;
}

async function deleteChunks(from: number, to: number) {
  for (let i = from; i < to; i++) await SecureStore.deleteItemAsync(`${PREFIX}.${i}`, OPTS);
}

export function getSession(): Promise<string | null> {
  return serial(async () => {
    const n = await readCount();
    if (!n) return null;
    let out = '';
    for (let i = 0; i < n; i++) {
      const part = await SecureStore.getItemAsync(`${PREFIX}.${i}`, OPTS);
      if (part == null) return null; // torn write: treat as no session rather than returning garbage
      out += part;
    }
    return out;
  });
}

export function setSession(value: string): Promise<void> {
  if (value === '') return clearSession();
  return serial(async () => {
    if (typeof value !== 'string') throw new TypeError('setSession expects a string');
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK) parts.push(value.slice(i, i + CHUNK));
    if (parts.length > MAX_CHUNKS) throw new Error('session value too large');
    const old = await readCount();
    for (let i = 0; i < parts.length; i++) await SecureStore.setItemAsync(`${PREFIX}.${i}`, parts[i], OPTS);
    await SecureStore.setItemAsync(COUNT_KEY, String(parts.length), OPTS);
    if (old > parts.length) await deleteChunks(parts.length, old);
  });
}

export function clearSession(): Promise<void> {
  return serial(async () => {
    const old = await readCount();
    await SecureStore.deleteItemAsync(COUNT_KEY, OPTS);
    await deleteChunks(0, Math.max(old, 1));
  });
}
