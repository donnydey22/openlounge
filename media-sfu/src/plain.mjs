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

/**
 * PJSIP/WASM legs over PlainTransport, dispatched from routeRpc for methods "plain:*". One plain transport per
 * session (bundle: audio+video share the rtcp-mux tuple). `emitTarget` publishes the {ip,port} tuple to the gateway
 * so ws-media-relay can resolve where to send a browser's packets.
 *   plain:create  -> { transportId, ip, port, srtpParameters }  (srtpParameters = SFU's tx key = client's rx key)
 *   plain:connect { srtpParameters:{cryptoSuite,keyBase64} }   (client's tx key, from its a=crypto)
 *   plain:produce { kind, ssrc | ssrcs[3], codec?, payloadType? } -> { id }
 *   plain:consume -> { consumers:[{id,producerId,kind,ssrc,payloadType}] }  (resumed immediately)
 */
export async function handlePlainRpc({ method, payload = {}, s, router, peers, announcedAddress, bindIp = "0.0.0.0", emitTarget = () => {}, notify = () => {} }) {
  if (method === "plain:create") {
    s.transports.get("plain")?.close();
    const t = await router.createPlainTransport({ ...plainTransportOptions({ listenIp: bindIp, announcedAddress }), appData: { callId: s.callId, userId: s.userId } });
    s.transports.set("plain", t);
    const ip = announcedAddress || t.tuple.localAddress || t.tuple.localIp, port = t.tuple.localPort;
    emitTarget({ callId: s.callId, userId: s.userId, ip, port });
    return { transportId: t.id, ip, port, srtpParameters: t.srtpParameters };
  }
  const t = s.transports.get("plain");
  if (!t) throw new Error("No plain transport");
  if (method === "plain:connect") {
    const sp = payload.srtpParameters;
    if (!sp || sp.cryptoSuite !== PLAIN_SRTP_SUITE || typeof sp.keyBase64 !== "string") throw new Error("Invalid SRTP parameters");
    await t.connect({ srtpParameters: sp });
    return {};
  }
  if (method === "plain:produce") {
    let rtpParameters;
    if (payload.kind === "audio") {
      if (!Number.isInteger(payload.ssrc)) throw new Error("ssrc");
      rtpParameters = { codecs: [{ mimeType: "audio/opus", payloadType: payload.payloadType ?? 111, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 } }], encodings: [{ ssrc: payload.ssrc }] };
    } else if (payload.kind === "video") {
      const base = { codec: payload.codec ?? "h264", payloadType: payload.payloadType ?? 102 };
      if (Array.isArray(payload.ssrcs)) rtpParameters = simulcastProducerParams({ ...base, ssrcs: payload.ssrcs }); // phones: 3-layer simulcast
      else if (Number.isInteger(payload.ssrc)) rtpParameters = { ...simulcastProducerParams({ ...base, ssrcs: [1, 2, 3] }), encodings: [{ ssrc: payload.ssrc }] }; // browser: 1 layer
      else throw new Error("ssrc");
    } else throw new Error("Unsupported media kind");
    s.producers.get(payload.kind)?.close();
    const p = await t.produce({ kind: payload.kind, rtpParameters, appData: { callId: s.callId, userId: s.userId, kind: payload.kind } });
    s.producers.set(payload.kind, p);
    notify("ms:consumer:available");
    return { id: p.id };
  }
  if (method === "plain:consume") {
    const consumers = [];
    for (const peer of peers) {
      if (peer === s || peer.callId !== s.callId) continue;
      for (const producer of peer.producers.values()) {
        if (s.consumers.has(producer.id) || !router.canConsume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities })) continue;
        const c = await t.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: false, appData: { callId: s.callId, userId: s.userId } });
        c.on("producerclose", () => { s.consumers.delete(producer.id); c.close(); });
        s.consumers.set(producer.id, c);
        consumers.push({ id: c.id, producerId: producer.id, kind: c.kind, ssrc: c.rtpParameters.encodings[0].ssrc, payloadType: c.rtpParameters.codecs[0].payloadType, mimeType: c.rtpParameters.codecs[0].mimeType });
      }
    }
    return { consumers };
  }
  throw new Error("Unsupported plain action");
}
