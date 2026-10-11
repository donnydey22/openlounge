import { pathToFileURL } from "node:url";

const PRODUCTION_HOSTS = new Set([
  "openlounge.app",
  "www.openlounge.app",
  "openlounge-production.up.railway.app",
]);
const BROWSERS = new Set(["chromium", "firefox", "webkit"]);
const TURN_PROTOCOLS = new Set(["turn:", "turns:"]);
const MIN_CREDENTIAL_LIFETIME_S = 30;
const MAX_CREDENTIAL_LIFETIME_S = 15 * 60;
const DEFAULT_TIMEOUT_MS = 45_000;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function canonicalHost(host) {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

function parseInteger(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  return Number(value);
}

function parseTurnUrls(value) {
  const urls = value.split(",").map((url) => url.trim()).filter(Boolean);
  if (!urls.length) throw new Error("TURN_RELAY_TEST_URLS must contain at least one TURN URL");

  for (const value of urls) {
    const match = /^(turns?):(.+)$/i.exec(value);
    if (!match || !TURN_PROTOCOLS.has(`${match[1].toLowerCase()}:`)) {
      throw new Error("TURN_RELAY_TEST_URLS must contain credential-free turn: or turns: URLs");
    }
    let endpoint;
    try {
      endpoint = new URL(`https://${match[2]}`);
    } catch {
      throw new Error("TURN_RELAY_TEST_URLS contains an invalid URL");
    }
    if (!endpoint.hostname || endpoint.username || endpoint.password) {
      throw new Error("TURN_RELAY_TEST_URLS must contain credential-free turn: or turns: URLs");
    }
  }
  return urls;
}

/**
 * Reads only short-lived coturn REST credentials. TURN_STATIC_SECRET is deliberately not an input.
 * An explicit non-production host allowlist prevents accidental production execution.
 */
export function readRelayHarnessConfig(env = process.env, nowMs = Date.now()) {
  const stagingUrl = new URL(required(env, "TURN_RELAY_TEST_STAGING_URL"));
  const allowedHost = canonicalHost(required(env, "TURN_RELAY_TEST_ALLOWED_HOST"));
  const host = canonicalHost(stagingUrl.hostname);

  if (stagingUrl.protocol !== "https:") throw new Error("TURN_RELAY_TEST_STAGING_URL must use HTTPS");
  if (PRODUCTION_HOSTS.has(host)) throw new Error("Refusing to run the relay harness against the production host");
  if (host !== allowedHost) throw new Error("TURN_RELAY_TEST_STAGING_URL host must exactly match TURN_RELAY_TEST_ALLOWED_HOST");

  const username = required(env, "TURN_RELAY_TEST_USERNAME");
  const credential = required(env, "TURN_RELAY_TEST_CREDENTIAL");
  const usernameParts = username.split(":", 2);
  if (usernameParts.length !== 2 || !usernameParts[1]) {
    throw new Error("TURN_RELAY_TEST_USERNAME must use coturn REST form <unix-expiry>:<opaque-id>");
  }
  const expiresAt = parseInteger(usernameParts[0], "TURN_RELAY_TEST_USERNAME expiry");
  const nowS = Math.floor(nowMs / 1000);
  if (expiresAt < nowS + MIN_CREDENTIAL_LIFETIME_S) {
    throw new Error("TURN_RELAY_TEST_USERNAME expires too soon; mint fresh staging credentials");
  }
  if (expiresAt > nowS + MAX_CREDENTIAL_LIFETIME_S) {
    throw new Error("TURN_RELAY_TEST_USERNAME must be short-lived (15 minutes or less)");
  }

  const browser = (env.TURN_RELAY_TEST_BROWSER || "chromium").trim().toLowerCase();
  if (!BROWSERS.has(browser)) throw new Error("TURN_RELAY_TEST_BROWSER must be chromium, firefox, or webkit");

  const timeoutMs = env.TURN_RELAY_TEST_TIMEOUT_MS
    ? parseInteger(env.TURN_RELAY_TEST_TIMEOUT_MS, "TURN_RELAY_TEST_TIMEOUT_MS")
    : DEFAULT_TIMEOUT_MS;
  if (timeoutMs < 5_000 || timeoutMs > 120_000) {
    throw new Error("TURN_RELAY_TEST_TIMEOUT_MS must be between 5000 and 120000");
  }

  return {
    stagingUrl: stagingUrl.toString(),
    allowedHost,
    browser,
    timeoutMs,
    iceServers: [{ urls: parseTurnUrls(required(env, "TURN_RELAY_TEST_URLS")), username, credential, credentialType: "password" }],
  };
}

export function sanitizedSummary(config) {
  return {
    stagingHost: config.allowedHost,
    browser: config.browser,
    turnUrlCount: config.iceServers[0].urls.length,
    timeoutMs: config.timeoutMs,
  };
}

async function runRelayProbe(page, config) {
  return page.evaluate(async ({ iceServers, timeoutMs }) => {
    const withTimeout = (promise, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
    const relayType = (candidate) => /\btyp\s+(\w+)/.exec(candidate)?.[1] || "unknown";

    const a = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay", iceCandidatePoolSize: 0 });
    const b = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay", iceCandidatePoolSize: 0 });
    const candidates = { a: [], b: [] };
    const pendingForA = [];
    const pendingForB = [];
    const candidateErrors = [];

    try {
      const connected = new Promise((resolve, reject) => {
        let aConnected = false;
        let bConnected = false;
        const onState = () => {
          if (["failed", "closed"].includes(a.connectionState) || ["failed", "closed"].includes(b.connectionState)) {
            reject(new Error(`peer connection failed (${a.connectionState}/${b.connectionState})`));
          }
          aConnected ||= a.connectionState === "connected";
          bConnected ||= b.connectionState === "connected";
          if (aConnected && bConnected) resolve();
        };
        a.addEventListener("connectionstatechange", onState);
        b.addEventListener("connectionstatechange", onState);
      });

      const forward = (target, queue, candidate) => {
        if (target.remoteDescription) {
          target.addIceCandidate(candidate).catch((error) => candidateErrors.push(error));
        } else {
          queue.push(candidate);
        }
      };
      const flush = async (target, queue) => {
        while (queue.length) await target.addIceCandidate(queue.shift());
      };

      a.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        candidates.a.push(candidate.candidate);
        forward(b, pendingForB, candidate);
      };
      b.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        candidates.b.push(candidate.candidate);
        forward(a, pendingForA, candidate);
      };

      const dataRoundTrip = new Promise((resolve, reject) => {
        const channel = a.createDataChannel("turn-relay-probe");
        channel.onopen = () => channel.send("relay-probe");
        channel.onmessage = ({ data }) => data === "relay-ok" ? resolve() : reject(new Error("unexpected relay probe response"));
        channel.onerror = () => reject(new Error("relay probe data channel failed"));
        b.ondatachannel = ({ channel: peerChannel }) => {
          peerChannel.onmessage = ({ data }) => { if (data === "relay-probe") peerChannel.send("relay-ok"); };
          peerChannel.onerror = () => reject(new Error("relay probe peer data channel failed"));
        };
      });

      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      await flush(b, pendingForB);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
      await flush(a, pendingForA);

      await withTimeout(Promise.all([connected, dataRoundTrip]), "forced relay connection");
      if (candidateErrors.length) throw candidateErrors[0];
      const stats = await a.getStats();
      const selectedPair = [...stats.values()].find((report) => report.type === "candidate-pair" && (report.selected || (report.nominated && report.state === "succeeded")));
      if (!selectedPair) throw new Error("no selected ICE candidate pair was reported");

      const local = stats.get(selectedPair.localCandidateId);
      const remote = stats.get(selectedPair.remoteCandidateId);
      if (local?.candidateType !== "relay" || remote?.candidateType !== "relay") {
        throw new Error(`selected candidate pair is not relay/relay (${local?.candidateType || "unknown"}/${remote?.candidateType || "unknown"})`);
      }
      if (!candidates.a.some((candidate) => relayType(candidate) === "relay") || !candidates.b.some((candidate) => relayType(candidate) === "relay")) {
        throw new Error("one or both peers did not gather a relay candidate");
      }

      return {
        candidateTypes: {
          a: [...new Set(candidates.a.map(relayType))],
          b: [...new Set(candidates.b.map(relayType))],
        },
        selectedPair: {
          localCandidateType: local.candidateType,
          localProtocol: local.protocol || "unknown",
          remoteCandidateType: remote.candidateType,
          remoteProtocol: remote.protocol || "unknown",
        },
      };
    } finally {
      a.close();
      b.close();
    }
  }, { iceServers: config.iceServers, timeoutMs: config.timeoutMs });
}

export async function main(env = process.env) {
  const config = readRelayHarnessConfig(env);
  const { chromium, firefox, webkit } = await import("playwright");
  const browserType = { chromium, firefox, webkit }[config.browser];
  const browser = await browserType.launch({ headless: env.TURN_RELAY_TEST_HEADLESS !== "0" });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(config.stagingUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
    if (canonicalHost(new URL(page.url()).hostname) !== config.allowedHost) {
      throw new Error("staging page redirected away from TURN_RELAY_TEST_ALLOWED_HOST");
    }
    const result = await runRelayProbe(page, config);
    await context.close();
    console.log(JSON.stringify({ status: "passed", ...sanitizedSummary(config), ...result }));
  } finally {
    await browser.close();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`TURN relay harness failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
