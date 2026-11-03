// PJSIP phone/browser legs -> mediasoup PlainTransport (Donny 12:37 AM: phones connect straight to PlainTransport,
// no ICE; per-leg SRTP SDES AES_CM_128_HMAC_SHA1_80, unchanged baseline per t4463u). Video per t4464u: H.264 base,
// AV1 only when the device reports hardware AV1, 3-layer SSRC simulcast forwarded per subscriber via layers.mjs.
export const PLAIN_SRTP_SUITE = "AES_CM_128_HMAC_SHA1_80";
export const VIDEO_CODECS = Object.freeze({
  h264: { kind: "video", mimeType: "video/H264", clockRate: 90_000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 } },
  av1: { kind: "video", mimeType: "video/AV1", clockRate: 90_000, parameters: {} },
});
// Simulcast ladder (spatial 0/1/2) — matches LAYER_POLICY.layerBps.
export const SIMULCAST = Object.freeze([
  { scale: 4, maxBitrate: 150_000, maxFps: 15 }, { scale: 2, maxBitrate: 400_000, maxFps: 30 }, { scale: 1, maxBitrate: 1_200_000, maxFps: 30 },
]);
// QuickHD-style start burst: top layer allowed above steady cap for the first seconds, then settle. Iterate from prod data.
export const QUICKHD = Object.freeze({ durationMs: 4_000, topLayerBitrate: 2_500_000, topLayerHeight: 1080, steadyHeight: 720 });

export function plainTransportOptions({ listenIp = "0.0.0.0", announcedAddress } = {}) {
  return { listenInfo: { protocol: "udp", ip: listenIp, ...(announcedAddress ? { announcedAddress } : {}) }, rtcpMux: true, comedia: true, enableSrtp: true, srtpCryptoSuite: PLAIN_SRTP_SUITE };
}
/** Codec negotiated per device: AV1 only if both ends report hardware AV1, else H.264. */
export function pickVideoCodec(sender = {}, receiver = {}) { return sender.hwAv1 && receiver.hwAv1 ? "av1" : "h264"; }
/** Producer rtpParameters for an SSRC-simulcast video leg from a PJSIP endpoint. */
export function simulcastProducerParams({ codec = "h264", payloadType = 102, ssrcs }) {
  if (!Array.isArray(ssrcs) || ssrcs.length !== SIMULCAST.length) throw new Error("need 3 ssrcs");
  const c = VIDEO_CODECS[codec]; if (!c) throw new Error("codec");
  return { codecs: [{ mimeType: c.mimeType, payloadType, clockRate: c.clockRate, parameters: c.parameters, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "ccm", parameter: "fir" }] }],
    encodings: ssrcs.map((ssrc, i) => ({ ssrc, maxBitrate: SIMULCAST[i].maxBitrate, scaleResolutionDownBy: SIMULCAST[i].scale })), rtcp: { cname: `ol-${ssrcs[0]}`, reducedSize: true } };
}
/** Top-layer cap at time t after call start (QuickHD burst, then steady). */
export function topLayerCap(msSinceStart) { return msSinceStart < QUICKHD.durationMs ? QUICKHD.topLayerBitrate : SIMULCAST[2].maxBitrate; }
