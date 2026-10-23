// Donny's rule: a call that recovered (or started) on the SFU's ICE-TCP port switches back to UDP by itself once UDP
// works again. The probe is an in-place ICE restart on the live transports: the current TCP pair keeps carrying audio
// until ICE nominates the (higher-priority) UDP pair, so there is no teardown and no audio gap.

type StatLike = { type?: string; id?: string; selected?: boolean; nominated?: boolean; state?: string; localCandidateId?: string; selectedCandidatePairId?: string; protocol?: string; relayProtocol?: string; candidateType?: string };

/** Protocol ("udp" | "tcp") of the selected ICE pair of one transport's stats, or null when unknown.
 *  A relay candidate's own `protocol` is the TURN server→peer leg (always "udp"); what the client actually sends on is
 *  `relayProtocol`. TURN-over-TLS/TCP (turns:…:443) therefore counts as TCP — that is the fallback we must climb out of.
 *  (Before Oct 23 this read relay/tls as "udp", so a call stuck on TURNS:443 was never probed back to UDP.) */
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
  const relay = String(local?.relayProtocol ?? "").toLowerCase();
  if (local?.candidateType === "relay" || relay) {
    if (relay === "tcp" || relay === "tls") return "tcp";
    if (relay === "udp") return "udp";
  }
  const p = String(local?.protocol ?? "").toLowerCase();
  return p === "udp" || p === "tcp" ? p : null;
}

/** true when any transport's selected pair runs over TCP */
export function anyOnTcp(reports: Array<{ forEach(cb: (v: StatLike) => void): void }>): boolean {
  return reports.some((r) => selectedProtocol(r) === "tcp");
}

/** after (or while) on UDP: re-check the selected pair this often for the whole call (getStats only, no restart) */
export const UDP_WATCH_MS = 10_000;

/** probe schedule after landing on TCP: soon first, then backing off (never gives up while on TCP) */
export const UDP_PROBE_DELAYS_MS = [3_000, 5_000, 10_000, 15_000, 30_000, 60_000];
export function udpProbeDelay(attempt: number) {
  return UDP_PROBE_DELAYS_MS[Math.min(attempt, UDP_PROBE_DELAYS_MS.length - 1)];
}

/** Short path label for telemetry: "udp" (direct host/srflx/prflx), "relay-udp", "relay-tcp", "relay-tls", "tcp" (ICE-TCP). */
export function selectedPath(report: { forEach(cb: (v: StatLike) => void): void } | null | undefined): string {
  if (!report) return "";
  const all: StatLike[] = [];
  report.forEach((v) => all.push(v));
  const byId = new Map(all.map((v) => [v.id, v]));
  const transport = all.find((v) => v.type === "transport" && v.selectedCandidatePairId);
  let pair = transport ? byId.get(transport.selectedCandidatePairId) : undefined;
  pair ??= all.find((v) => v.type === "candidate-pair" && (v.selected || (v.nominated && v.state === "succeeded")));
  const local = pair?.localCandidateId ? byId.get(pair.localCandidateId) : undefined;
  if (!local) return "";
  if (local.candidateType === "relay") return `relay-${String(local.relayProtocol ?? "udp").toLowerCase()}`;
  return String(local.protocol ?? "").toLowerCase();
}
