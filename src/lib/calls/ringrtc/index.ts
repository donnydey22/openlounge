export { OlSession, type Envelope, type PreKeyBundle, type PreKeyHeader } from "./olx3dh";
export { OlKeyStore, memoryKv, type Kv } from "./keyStore";
export { SealedSignaling } from "./SealedSignaling";
export { RcCall, RcCallManager, type RcCallState, type RcCallEvent, type RcHangupType } from "./CallManager";
export { idbKv, sharedKeyStore } from "./keyStore";
import type { RtcSocket } from "../rtc/CallSession";
import { sharedKeyStore } from "./keyStore";
import { SealedSignaling as SS } from "./SealedSignaling";
const published = new WeakSet<object>();
/** publish (once per socket) this device's OLX3DH-v1 bundle so peers can open a session to us */
export async function ensureRcKeysPublished(sock: RtcSocket) {
  if (published.has(sock)) return; published.add(sock);
  const r = await sock.request<{ ok: boolean }>("rc:keys:publish", await sharedKeyStore().publishable()).catch(() => null);
  if (!r?.ok) published.delete(sock);
}
export const sealedFor = (sock: RtcSocket, o: { callId: string; role: "caller" | "callee"; peerUserId: string; log?(ev: string, d?: Record<string, unknown>): void }) => new SS(sock, sharedKeyStore(), o);
