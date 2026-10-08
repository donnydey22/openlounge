"use client";
// Shared data-saver setting (chat media now; calls can read the same switch): "auto" follows the OS/browser
// (Save-Data / 2G), "on" always saves data, "off" never does. Stored per device.
export type DataSaverMode = "auto" | "on" | "off";
const KEY = "openlounge:data-saver";
export const DATA_SAVER_EVENT = "openlounge:data-saver";

type Conn = { saveData?: boolean; effectiveType?: string; downlink?: number; rtt?: number; type?: string; addEventListener?: (t: string, f: () => void) => void };
const conn = (): Conn | undefined => (typeof navigator === "undefined" ? undefined : (navigator as unknown as { connection?: Conn }).connection);

export function dataSaverMode(): DataSaverMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}
export function setDataSaverMode(m: DataSaverMode) {
  try {
    if (m === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, m);
  } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DATA_SAVER_EVENT, { detail: m }));
}

/** The browser/OS asks for less data (Save-Data) or the link is 2G-class. */
export function systemSaveData() {
  const c = conn();
  return !!c?.saveData || c?.effectiveType === "2g" || c?.effectiveType === "slow-2g";
}
export function dataSaverOn() {
  const m = dataSaverMode();
  return m === "on" || (m === "auto" && systemSaveData());
}

/**
 * Network hint for adaptive media: slow = 3G-class or worse / Save-Data / data saver; cellular when the UA says so.
 * estimateBps seeds the ABR estimate (Network Information API where available; conservative default otherwise).
 */
export function networkHint() {
  const c = conn();
  const cellular = c?.type === "cellular";
  const et = c?.effectiveType;
  const downlink = typeof c?.downlink === "number" && c.downlink > 0 ? c.downlink : null; // Mbit/s (capped at 10 by spec)
  const slow = dataSaverOn() || et === "3g" || et === "2g" || et === "slow-2g" || (downlink !== null && downlink < 1.5) || (typeof c?.rtt === "number" && c.rtt >= 400);
  const estimateBps = downlink !== null ? Math.round(downlink * 1e6 * 0.8) : slow || cellular ? 400_000 : 1_000_000;
  return { slow, cellular, estimateBps, saver: dataSaverOn() };
}
