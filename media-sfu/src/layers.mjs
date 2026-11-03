// FX-080 SFU preferred-layer policy for simulcast consumers (3 spatial layers: 0 low, 1 mid, 2 high).
// mediasoup already lets BWE cap the layer; this adds receiver-loss awareness with hysteresis so a lossy receiver
// drops a layer within ~2 samples and climbs back one layer after ~3 clean samples (proactive, not only after it tanks).
// Video spec v2 (Donny 6:51 AM): 1 s tick on REMB/transport-cc BWE; downgrade as soon as loss > 2%; upgrade one layer
// after 5 consecutive clean seconds (clean = loss <= 0.5%). layerBps = iOS ladder (Android 120/600/1600 fits under it).
export const LAYER_POLICY = Object.freeze({ sampleMs: 1_000, downLossPct: 2, severeLossPct: 20, upLossPct: 0.5, upAfter: 5, downAfter: 1,
  layerBps: [150_000, 800_000, 2_400_000], headroom: 1.2, maxSpatial: 2, temporalMax: 2 });

/** Pure: next preferred spatial layer given the receiver's loss %, available outgoing bitrate and prior state. */
export function nextLayer(state, sample, p = LAYER_POLICY) {
  const st = { spatial: state?.spatial ?? p.maxSpatial, bad: state?.bad ?? 0, good: state?.good ?? 0 };
  const loss = Number.isFinite(sample?.lossPct) ? sample.lossPct : 0;
  const bwe = Number.isFinite(sample?.availableBps) ? sample.availableBps : Infinity;
  // bandwidth ceiling: highest layer whose bitrate (with headroom) fits the receiver's estimate; layer 0 always allowed
  let ceil = 0;
  for (let i = p.maxSpatial; i > 0; i--) if (p.layerBps[i] * p.headroom <= bwe) { ceil = i; break; }
  if (loss >= p.severeLossPct) return { spatial: 0, bad: 0, good: 0 };
  if (loss > p.downLossPct) {
    st.bad++; st.good = 0;
    if (st.bad >= p.downAfter) return { spatial: Math.max(0, Math.min(st.spatial, ceil) - 1), bad: 0, good: 0 };
    return { ...st, spatial: Math.min(st.spatial, ceil) };
  }
  st.bad = 0;
  if (st.spatial > ceil) return { spatial: ceil, bad: 0, good: 0 };
  if (loss <= p.upLossPct && st.spatial < ceil) {
    st.good++;
    if (st.good >= p.upAfter) return { spatial: st.spatial + 1, bad: 0, good: 0 };
    return st;
  }
  return { ...st, good: 0 };
}
