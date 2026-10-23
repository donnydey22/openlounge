// Server media allowance (Settings → Storage & data). REPORT ONLY: nothing is enforced, nothing is deleted.
// Enforcing a per-user cap needs Donny's ok (and a product decision on what happens at the cap: new uploads only,
// never existing messages / text).
//
//   usable    = volumeBytes × targetFill − reserveBytes          (headroom for processing, HLS ladders, backups)
//   fairShare = usable / max(activeSenders, 1)                    (senders with media in the last 30 days)
//   allowance = clamp(fairShare, floorBytes, ceilBytes)
//
// Defaults match the Railway volume today (4.9 GB, 80% target fill, 0.5 GB reserve, 250 MB floor, 2 GB ceiling).
export type AllowanceInput = { volumeBytes: number; activeSenders: number; targetFill?: number; reserveBytes?: number; floorBytes?: number; ceilBytes?: number };

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const ALLOWANCE_DEFAULTS = {
  volumeBytes: num(process.env.MEDIA_VOLUME_BYTES, 4.9 * GB),
  targetFill: 0.8,
  reserveBytes: 0.5 * GB,
  floorBytes: 250 * MB,
  ceilBytes: 2 * GB,
};

export function allowance(i: AllowanceInput) {
  const targetFill = i.targetFill ?? ALLOWANCE_DEFAULTS.targetFill;
  const reserve = i.reserveBytes ?? ALLOWANCE_DEFAULTS.reserveBytes;
  const floor = i.floorBytes ?? ALLOWANCE_DEFAULTS.floorBytes;
  const ceil = i.ceilBytes ?? ALLOWANCE_DEFAULTS.ceilBytes;
  const usable = Math.max(0, i.volumeBytes * targetFill - reserve);
  const fair = usable / Math.max(1, i.activeSenders);
  return { usable: Math.round(usable), fairShare: Math.round(fair), allowance: Math.round(Math.min(ceil, Math.max(floor, fair))), enforced: false as const };
}
