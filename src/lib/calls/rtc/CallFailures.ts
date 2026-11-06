// Typed call failures (Signal-style split between local media failures and network/transport failures).
// RULE: permission/device/session/codec failures are LOCAL. They never trigger ICE restart or TURN relay.
// Zero bitrate / silent audio / mute are not failures at all and are never classified as network.

export type FailureKind = "permission" | "device" | "session" | "codec" | "network" | "signaling";

export class CallFailure extends Error {
  constructor(readonly kind: FailureKind, readonly code: string, message?: string, readonly original?: unknown) {
    super(message ?? `${kind}:${code}`);
    this.name = "CallFailure";
  }
  get local(): boolean {
    return isLocal(this.kind);
  }
}

export const isLocal = (k: FailureKind) => k === "permission" || k === "device" || k === "session" || k === "codec";
/** Only these may start network recovery (ICE restart, which may select an OL TURN relay candidate). */
export const mayRecoverOverNetwork = (f: CallFailure) => f.kind === "network";

/** Map getUserMedia / setSinkId / play() DOMExceptions to local failure kinds, keeping the original name. */
export function fromMediaError(e: unknown): CallFailure {
  if (e instanceof CallFailure) return e;
  const name = String((e as { name?: string })?.name ?? "Error");
  const msg = String((e as Error)?.message ?? e);
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return new CallFailure("permission", name, msg, e);
    case "NotFoundError":
    case "OverconstrainedError":
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new CallFailure("device", name, msg, e);
    case "NotSupportedError":
      return new CallFailure("codec", name, msg, e);
    default:
      return new CallFailure("session", name, msg, e);
  }
}

/** ICE/connection state → failure (network) or null (not a failure). */
export function fromIceState(state: RTCIceConnectionState | RTCPeerConnectionState): CallFailure | null {
  return state === "failed" ? new CallFailure("network", `ice-${state}`) : null;
}

export function fromSignalingError(code: string): CallFailure {
  return new CallFailure("signaling", code);
}
