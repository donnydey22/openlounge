// Device-tier hints for thermals/battery: low-end phones get fewer animations and a slower audio meter.
type Nav = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };

export function isLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const n = navigator as Nav;
  return (n.deviceMemory !== undefined && n.deviceMemory <= 2) || (n.hardwareConcurrency !== undefined && n.hardwareConcurrency <= 4 && (n.deviceMemory ?? 4) <= 3) || n.connection?.saveData === true;
}

export function prefersLowMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches || isLowEndDevice();
}

/** Audio level meter rate (Hz): ≤15 normally, 8 on low-end devices. */
export const meterHz = () => (isLowEndDevice() ? 8 : 15);

/** Mark <html data-lowend> so CSS can drop decorative motion. */
export function applyDeviceClass() {
  if (typeof document !== "undefined" && isLowEndDevice()) document.documentElement.dataset.lowend = "";
}
