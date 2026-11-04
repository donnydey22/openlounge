// Callee offline -> app server rings it: APNs VoIP (iOS CallKit) + FCM high-priority (Android). Logs sent; never the secret.
export function signalPushFor({ url, secret, fetchImpl = fetch } = {}) {
  return async function signalPush(to, p) {
    if (!url || !secret) return console.log(`[push] disabled (no CALL_SIGNAL_PUSH_URL/SECRET) call ${p.callId}`);
    const t0 = Date.now();
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ to, ...p }), signal: AbortSignal.timeout(5000) });
      const j = await r.json().catch(() => ({}));
      console.log(`[push] sent call=${p.callId} to=${to} http=${r.status} voipSent=${j.voipSent ?? "-"} fcm=${j.fcm ?? "-"} ms=${Date.now() - t0}`);
    } catch (e) { console.log(`[push] failed call=${p.callId} to=${to} ${String(e?.name || e)} ms=${Date.now() - t0}`); }
  };
}
