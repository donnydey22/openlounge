import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const bashSyntax = (relative) => spawnSync("bash", ["-n", path.join(root, relative)], { encoding: "utf8" });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, timeout = 4_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  throw new Error("timed out waiting for condition");
};
const exited = (child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

function startWatchdog({ healthyAtStart = true, nodeExit = null, startTimeout = "5" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openlounge-watchdog-"));
  const health = path.join(dir, "health.json");
  const log = path.join(dir, "notify.log");
  const nodeBin = path.join(dir, "node");
  const notifyBin = path.join(dir, "notify");
  const curlBin = path.join(dir, "curl");
  fs.writeFileSync(health, healthyAtStart ? '{"ok":true,"worker":true,"gateway":true}' : "");
  fs.writeFileSync(log, "");
  fs.writeFileSync(nodeBin, `#!/usr/bin/env bash\n${nodeExit === null ? "exec sleep 30" : `exit ${nodeExit}`}\n`);
  fs.writeFileSync(notifyBin, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >>\"$NOTIFY_LOG\"\n");
  fs.writeFileSync(curlBin, "#!/usr/bin/env bash\nif [[ -s \"$FAKE_HEALTH_FILE\" ]]; then cat \"$FAKE_HEALTH_FILE\"; exit 0; fi\nexit 7\n");
  for (const file of [nodeBin, notifyBin, curlBin]) fs.chmodSync(file, 0o755);
  const child = spawn("bash", ["deploy/run-with-watchdog.sh"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      NOTIFY_SOCKET: "test-notify",
      NOTIFY_LOG: log,
      FAKE_HEALTH_FILE: health,
      OPENLOUNGE_NODE_BIN: nodeBin,
      SYSTEMD_NOTIFY_BIN: notifyBin,
      MEDIASOUP_HEALTH_PORT: "8081",
      MEDIASOUP_WATCHDOG_START_TIMEOUT_SEC: startTimeout,
      WATCHDOG_USEC: "3000000",
    },
  });
  return {
    child,
    health,
    log,
    readLog: () => fs.readFileSync(log, "utf8"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("reviewed installer is deterministic on a clean archive and keeps dependency writes non-root", () => {
  const install = read("deploy/install-reviewed.sh");
  assert.match(install, /bash "\$root\/media-sfu\/deploy\/preflight\.sh"/);
  assert.match(install, /bash "\$root\/media-sfu\/deploy\/verify-network-boundary\.sh"/);
  assert.match(install, /bash "\$root\/media-sfu\/deploy\/backup-coturn-config\.sh"/);
  assert.match(install, /--chown=openlounge-sfu:openlounge-sfu/);
  assert.match(install, /sudo -u openlounge-sfu env PATH="\/opt\/openlounge-node\/bin:/);
  assert.match(install, /MEDIASOUP_JOURNAL_APPROVED=YES/);
  assert.match(install, /apply-coturn-reserve\.sh/);
});

test("pinned Node installer uses a fixed official release and checksum", () => {
  const node = read("deploy/install-node22-lts.sh");
  assert.match(node, /node_version=v22\.23\.3/);
  assert.match(node, /https:\/\/nodejs\.org\/dist\/\$\{node_version\}/);
  assert.match(node, /df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de/);
  assert.match(node, /sha256sum -c -/);
  assert.doesNotMatch(node, /apt-get|NodeSource/i);
});

test("single SFU unit uses health-based watchdog and bounded journal output", () => {
  const unit = read("deploy/openlounge-mediasoup-sfu.service");
  assert.match(unit, /^Type=notify$/m);
  assert.match(unit, /^ExecStart=\/bin\/bash deploy\/run-with-watchdog\.sh$/m);
  assert.match(unit, /^WatchdogSec=30s$/m);
  assert.match(unit, /^NotifyAccess=all$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^LogRateLimitIntervalSec=30s$/m);
  assert.match(unit, /^LogRateLimitBurst=200$/m);
  const units = fs.readdirSync(path.join(root, "deploy")).filter((entry) => entry.endsWith(".service"));
  assert.deepEqual(units, ["openlounge-mediasoup-sfu.service"]);
});

test("network and coturn gates precede SFU enablement", () => {
  const install = read("deploy/install-reviewed.sh");
  assert.ok(install.indexOf("verify-network-boundary.sh") < install.indexOf("enable --now openlounge-mediasoup-sfu.service"));
  assert.ok(install.indexOf("apply-coturn-reserve.sh") < install.indexOf("enable --now openlounge-mediasoup-sfu.service"));
  const network = read("deploy/verify-network-boundary.sh");
  assert.match(network, /cloud_firewall_id=fde5a7b3-020b-4d9b-bcc6-40bac18e213f/);
  assert.match(network, /40000:49999\/udp/);
  assert.match(network, /root:root with mode 0600/);
  const coturn = read("deploy/apply-coturn-reserve.sh");
  assert.match(coturn, /systemctl set-property --runtime coturn\.service/);
  assert.match(coturn, /expect_cgroup memory\.min 805306368/);
  assert.match(coturn, /expect_cgroup cpu\.weight 1000/);
});

test("persistent journald policy covers persistent and runtime storage", () => {
  const journal = read("deploy/openlounge-media-journal.conf");
  for (const line of ["Storage=persistent", "SystemMaxUse=100M", "SystemKeepFree=256M", "SystemMaxFileSize=16M", "RuntimeMaxUse=32M", "RuntimeKeepFree=64M", "RuntimeMaxFileSize=8M", "MaxRetentionSec=14day"]) assert.match(journal, new RegExp(`^${line}$`, "m"));
  const configure = read("deploy/configure-journald.sh");
  assert.match(configure, /\/var\/log\/journal/);
  assert.match(configure, /journalctl --flush/);
});

test("watchdog wrapper signals readiness only while local health is healthy and shuts down cleanly", async () => {
  const run = startWatchdog();
  try {
    await waitFor(() => run.readLog().includes("--ready --status=healthy") && run.readLog().includes("WATCHDOG=1"));
    const before = (run.readLog().match(/WATCHDOG=1/g) ?? []).length;
    fs.writeFileSync(run.health, "");
    await delay(1_250);
    assert.equal((run.readLog().match(/WATCHDOG=1/g) ?? []).length, before, "health loss must stop watchdog pings");
    run.child.kill("SIGTERM");
    assert.equal((await exited(run.child)).code, 0);
    assert.match(run.readLog(), /--stopping --status=stopping/);
  } finally {
    run.child.kill("SIGKILL");
    run.cleanup();
  }
});

test("watchdog fails startup without a healthy loopback response and propagates a child crash", async () => {
  const unhealthy = startWatchdog({ healthyAtStart: false, startTimeout: "1" });
  try {
    assert.equal((await exited(unhealthy.child)).code, 1);
    assert.doesNotMatch(unhealthy.readLog(), /--ready/);
  } finally {
    unhealthy.child.kill("SIGKILL");
    unhealthy.cleanup();
  }
  const crashed = startWatchdog({ healthyAtStart: false, nodeExit: 3 });
  try {
    assert.equal((await exited(crashed.child)).code, 3);
    assert.doesNotMatch(crashed.readLog(), /--ready/);
  } finally {
    crashed.child.kill("SIGKILL");
    crashed.cleanup();
  }
});

test("deployment helpers and watchdog wrapper have valid shell syntax", () => {
  for (const relative of ["deploy/apply-coturn-reserve.sh", "deploy/configure-journald.sh", "deploy/install-node22-lts.sh", "deploy/run-with-watchdog.sh", "deploy/verify-network-boundary.sh", "deploy/install-reviewed.sh", "deploy/preflight.sh"]) {
    const result = bashSyntax(relative);
    assert.equal(result.status, 0, `${relative}: ${result.stderr}`);
  }
});
