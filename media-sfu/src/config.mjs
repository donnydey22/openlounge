const required = (env, key) => {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const port = (env, key, fallback) => {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${key} must be a TCP/UDP port`);
  return value;
};

const positive = (env, key, fallback) => {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
};

const ip = (value, key) => {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value !== "0.0.0.0") throw new Error(`${key} must be an IPv4 address`);
  return value;
};

/**
 * Parse the narrow first-pilot envelope. HTTP health listens on loopback only; browser control signaling stays on the
 * authenticated Open Lounge WebSocket. The WebRTC port range is intentionally distinct from coturn's 3478, 443 and
 * 50000-60000 relay range.
 */
export function readConfig(env = process.env) {
  const minPort = port(env, "MEDIASOUP_RTC_MIN_PORT", 40000);
  const maxPort = port(env, "MEDIASOUP_RTC_MAX_PORT", 49999);
  if (minPort > maxPort) throw new Error("MEDIASOUP_RTC_MIN_PORT must not exceed MEDIASOUP_RTC_MAX_PORT");
  for (const reserved of [3478, 443]) if (reserved >= minPort && reserved <= maxPort) throw new Error("Mediasoup RTC range must not include coturn listener ports");
  if (!(maxPort < 50000 || minPort > 60000)) throw new Error("Mediasoup RTC range must not overlap coturn relay ports 50000-60000");
  const gatewaySecret = required(env, "MEDIASOUP_GATEWAY_SECRET");
  const admissionSecret = required(env, "MEDIASOUP_ADMISSION_SECRET");
  if (Buffer.byteLength(gatewaySecret) < 32 || Buffer.byteLength(admissionSecret) < 32) throw new Error("Mediasoup secrets must be at least 32 bytes");
  const bindIp = ip(env.MEDIASOUP_LISTEN_IP ?? "0.0.0.0", "MEDIASOUP_LISTEN_IP");
  const announcedAddress = ip(required(env, "MEDIASOUP_ANNOUNCED_ADDRESS"), "MEDIASOUP_ANNOUNCED_ADDRESS");
  if (announcedAddress === "0.0.0.0") throw new Error("MEDIASOUP_ANNOUNCED_ADDRESS must be public");
  return {
    gatewayUrl: required(env, "OPENLOUNGE_GATEWAY_WS_URL"),
    gatewaySecret,
    admissionSecret,
    bindIp,
    announcedAddress,
    minPort,
    maxPort,
    // A one-core coturn co-location pilot must stay deliberately tiny. Capacity only expands after measured review.
    maxCalls: positive(env, "MEDIASOUP_MAX_CALLS", 2),
    healthHost: env.MEDIASOUP_HEALTH_HOST ?? "127.0.0.1",
    healthPort: port(env, "MEDIASOUP_HEALTH_PORT", 8081),
  };
}
