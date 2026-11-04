// TLS :8443 -> 127.0.0.1:3101 app; "GET /media-relay" upgrades -> 127.0.0.1:8092 ws-media-relay (pjsip TEST instance only)
import tls from "node:tls"; import net from "node:net"; import fs from "node:fs";
const L = "/etc/letsencrypt/live/turn.openlounge.app/";
const opts = () => ({ key: fs.readFileSync(L + "privkey.pem"), cert: fs.readFileSync(L + "fullchain.pem") });
tls.createServer(opts(), (s) => {
  s.on("error", () => {});
  s.once("data", (first) => {
    const relay = first.subarray(0, 32).toString("latin1").startsWith("GET /media-relay");
    const u = net.connect(relay ? 8092 : 3101, "127.0.0.1");
    u.on("error", () => s.destroy()); s.on("error", () => u.destroy());
    if (relay) first = Buffer.from(first.toString("latin1").replace(/^GET \/media-relay\/?/, "GET /"), "latin1");
    u.write(first); s.pipe(u).pipe(s);
  });
}).listen(8443, "::");
