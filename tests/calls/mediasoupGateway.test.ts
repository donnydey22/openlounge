import test from "node:test";
import assert from "node:assert/strict";
import { MediasoupGateway } from "../../server/mediasoup/gateway";

class FakeConn {
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  private closed: (() => void)[] = [];
  emit(event: string, data: unknown) {
    this.emitted.push({ event, data });
  }
  onClose(fn: () => void) {
    this.closed.push(fn);
  }
  close() {
    for (const fn of this.closed) fn();
  }
}

test("gateway forwards server-originated browser connection cleanup only after gateway authentication", () => {
  const secret = "g".repeat(32);
  const gateway = new MediasoupGateway({ gatewaySecret: secret, admissionSecret: "a".repeat(32) });
  const conn = new FakeConn();
  assert.deepEqual(gateway.attach(conn as never, secret), { ok: true });
  gateway.closeConnection("browser-connection-id");
  assert.deepEqual(conn.emitted, [{ event: "ms:gateway:closeConnection", data: { connectionId: "browser-connection-id" } }]);
  conn.close();
  gateway.closeConnection("ignored-after-gateway-close");
  assert.equal(conn.emitted.length, 1);
});
