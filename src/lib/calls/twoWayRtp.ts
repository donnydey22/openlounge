/** Two-way RTP gate: a call is "connected" only once audio RTP is both sent and received (growing counters).
 *  Reads every session kind's stats shape: WebRTC inbound/outbound-rtp audio, WASM "wasm-call", native PJSIP "pjsip". */
export type RtpCount = { rx: number; tx: number };
export function audioRtp(reports: Iterable<Map<string, Record<string, unknown>> | RTCStatsReport | Record<string, unknown>[]>): RtpCount {
  const c = { rx: 0, tx: 0 };
  const one = (s: Record<string, unknown>) => {
    const audio = s.kind === "audio" || s.mediaType === "audio";
    if (s.type === "inbound-rtp" && audio) c.rx += Number(s.packetsReceived ?? 0);
    else if (s.type === "outbound-rtp" && audio) c.tx += Number(s.packetsSent ?? 0);
    else if (s.type === "wasm-call") { c.rx += Number(s.packetsReceived ?? 0); c.tx += Number(s.packetsSent ?? 0); }
    else if (s.type === "pjsip") { c.rx += Number(s.rxPkt ?? 0); c.tx += Number(s.txPkt ?? 0); }
  };
  for (const r of reports) (Array.isArray(r) ? r : (r as Map<string, Record<string, unknown>>)).forEach((s: Record<string, unknown>) => one(s));
  return c;
}
/** Polls until both directions grew between two samples (no cap: stops only via stop()). */
export function watchTwoWay(stats: () => Promise<Iterable<any>>, onFlowing: () => void, onWaiting: (c: RtpCount, ms: number) => void, everyMs = 300) {
  let prev: RtpCount | null = null, stopped = false, lastLog = 0;
  const t0 = Date.now();
  const tick = async () => {
    if (stopped) return;
    const c = audioRtp(await stats().catch(() => []));
    if (stopped) return;
    if (prev && c.rx > prev.rx && c.tx > prev.tx) { stopped = true; clearInterval(h); onFlowing(); return; }
    prev = c;
    if (Date.now() - lastLog >= 5000) { lastLog = Date.now(); onWaiting(c, Date.now() - t0); }
  };
  const h = setInterval(() => void tick(), everyMs);
  return { stop() { stopped = true; clearInterval(h); } };
}
