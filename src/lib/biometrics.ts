// Opt-in biometric App lock, implemented by the native wrappers (Android BiometricPrompt, iOS LocalAuthentication).
// Contract: window.OpenLoungeNative.biometrics = { isAvailable(), getEnabled(), setEnabled(bool) }, each returning a
// Promise<boolean> (sync booleans are accepted too). setEnabled(true) shows the OS prompt first and resolves with the
// resulting state. Android also exposes the same object as window.OpenLoungeBiometrics (the WebView's Java bridge
// object may not accept new properties), so both are checked. The web app works without any of it.
export interface BiometricsBridge {
  isAvailable(): Promise<boolean> | boolean;
  getEnabled(): Promise<boolean> | boolean;
  setEnabled(on: boolean): Promise<boolean> | boolean;
}

type W = { OpenLoungeNative?: { biometrics?: BiometricsBridge }; OpenLoungeBiometrics?: BiometricsBridge };

const valid = (b: unknown): b is BiometricsBridge =>
  !!b &&
  typeof (b as BiometricsBridge).isAvailable === "function" &&
  typeof (b as BiometricsBridge).getEnabled === "function" &&
  typeof (b as BiometricsBridge).setEnabled === "function";

export function biometricsBridge(win: unknown = typeof window === "undefined" ? undefined : window): BiometricsBridge | null {
  if (!win) return null;
  const w = win as W;
  const b = w.OpenLoungeNative?.biometrics;
  if (valid(b)) return b;
  return valid(w.OpenLoungeBiometrics) ? w.OpenLoungeBiometrics! : null;
}

export async function readBiometrics(b: BiometricsBridge | null): Promise<{ available: boolean; enabled: boolean }> {
  if (!b) return { available: false, enabled: false };
  try {
    const available = (await b.isAvailable()) === true;
    const enabled = available && (await b.getEnabled()) === true;
    return { available, enabled };
  } catch {
    return { available: false, enabled: false };
  }
}

export async function setBiometrics(b: BiometricsBridge, on: boolean): Promise<boolean> {
  try {
    return (await b.setEnabled(on)) === true;
  } catch {
    return false;
  }
}
