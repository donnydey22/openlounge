// Donny's rule: a call that recovered (or started) on the SFU's ICE-TCP port switches back to UDP by itself once UDP
// works again. The probe is an in-place ICE restart on the live transports: the current TCP pair keeps carrying audio
// until ICE nominates the (higher-priority) UDP pair, so there is no teardown and no audio gap.

type StatLike = { type?: string; id?: string; selected?: boolean; nominated?: boolean; state?: string; localCandidateId?: string; selectedCandidatePairId?: string; protocol?: string; relayProtocol?: string };

/** Protocol ("udp" | "tcp") of the selected ICE pair of one transport's stats, or null when unknown. */
export function selectedProtocol(report: { forEach(cb: (v: StatLike) => void): void } | null | undefined): "udp" | "tcp" | null {
  if (!report) return null;
  const all: StatLike[] = [];
  report.forEach((v) => all.push(v));
  const byId = new Map(all.map((v) => [v.id, v]));
  const transport = all.find((v) => v.type === "transport" && v.selectedCandidatePairId);
  let pair = transport ? byId.get(transport.selectedCandidatePairId) : undefined;
  pair ??= all.find((v) => v.type === "candidate-pair" && (v.selected || (v.nominated && v.state === "succeeded")));
  if (!pair?.localCandidateId) return null;
  const local = byId.get(pair.localCandidateId);
  const p = String(local?.relayProtocol && local?.protocol === "udp" ? local.protocol : local?.protocol ?? "").toLowerCase();
  return p === "udp" || p === "tcp" ? p : null;
}

/** true when any transport's selected pair runs over TCP */
export function anyOnTcp(reports: Array<{ forEach(cb: (v: StatLike) => void): void }>): boolean {
  return reports.some((r) => selectedProtocol(r) === "tcp");
}

/** probe schedule after landing on TCP: soon first, then backing off (never gives up while on TCP) */
// Donny (Oct 16): UDP back as fast as possible, never give up. Each probe is an in-place ICE restart (no gap), so a
// tight schedule costs only a few STUN packets; steady state is one probe every 15 s while on TCP.
export const UDP_PROBE_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 12_000, 15_000];
export function udpProbeDelay(attempt: number) {
  return UDP_PROBE_DELAYS_MS[Math.min(attempt, UDP_PROBE_DELAYS_MS.length - 1)];
}
