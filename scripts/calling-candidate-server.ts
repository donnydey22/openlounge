// Isolated DO release candidate API + calling socket. NOT a production auth/data/frontend cutover.
import http from "node:http";
import { store } from "../server/store";
import { api, isApiRequest } from "../server/http";
import { WsHub } from "../server/ws";
import { registerRealtime } from "../server/realtime";
import { originAllowed } from "../server/auth";
async function main() {
await store.init();
const server = http.createServer((req, res) => {
  if (req.url === "/candidate-health") { res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({ok:true,calling:"sealed-rc-p2p",production:false})); return; }
  if (isApiRequest(req.url ?? "")) return void api(req,res).catch(()=>res.writeHead(503).end());
  res.writeHead(404).end();
});
registerRealtime(new WsHub(server, "/ws", req => originAllowed(req.headers.origin, req.headers.host)));
server.listen(Number(process.env.PORT || 3102), "127.0.0.1", ()=>console.log("Isolated calling candidate listening on loopback"));

}
void main().catch(e=>{console.error("candidate startup failed",e);process.exit(1)});
