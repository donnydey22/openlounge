// Production DO-only service. NO demo auth, platform cache/DB, Next or test bootstrap.
import https from "node:https";
import {CallingTls} from "../server/calls/bridge/tls";
import {BridgeAuth,BridgeClient,BridgeEndpoint,validateBridgeUrl,json} from "../server/calls/bridge/auth";
import {CallingRuntime} from "../server/calls/bridge/runtime";
async function main(){
 if(process.env.NODE_ENV!=="production")throw Error("production environment required");
 if(["DATABASE_URL","REDIS_URL","AUTH_SECRET","CALLING_BRIDGE_TEST"].some(k=>process.env[k]))throw Error("platform/test credentials prohibited on calling authority");
 const id=await(await fetch("http://169.254.169.254/metadata/v1/id",{signal:AbortSignal.timeout(3000)})).text();if(id.trim()!=="608073501")throw Error("wrong DO droplet");
 const incoming=process.env.CALLING_TO_DO_KEY??"",outgoing=process.env.CALLING_TO_PLATFORM_KEY??"";if(incoming===outgoing)throw Error("directional bridge keys must differ");
 const client=new BridgeClient(validateBridgeUrl(process.env.CALLING_PLATFORM_URL??"","platform"),new BridgeAuth(outgoing,"platform"));
 const runtime=new CallingRuntime(client,process.env.CALLING_STATE_DIR??"/var/lib/openlounge-calling");const ep=new BridgeEndpoint(new BridgeAuth(incoming,"calling"),(op,a)=>runtime.handle(op,a));
 const tls=new CallingTls(process.env.CALLING_TLS_DIR!);
 const server=https.createServer(tls.options(),(req,res)=>{if(req.url==="/healthz"&&req.method==="GET")return json(res,200,{ok:true,authority:"digitalocean",protocol:"ol-rc-v1",revision:process.env.CALLING_REVISION,production:true});if(req.url!=="/bridge/calling")return json(res,404,{error:"not_found"});void ep.handle(req,res,"/bridge/calling").catch(()=>json(res,500,{error:"internal"}))});
 server.maxConnections=512;server.maxRequestsPerSocket=500;server.requestTimeout=12_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;
 const reload=()=>{const status=tls.reload(server);if(status==="updated")console.log("[calling] TLS certificate context refreshed");if(status==="invalid")console.error("[calling] TLS reload failed; prior context retained")};reload();const watch=setInterval(reload,60_000);watch.unref();process.on("SIGHUP",reload);
 server.listen(Number(process.env.CALLING_PORT??18443),"0.0.0.0",()=>console.log("[calling] authenticated production DO authority ready"));
 process.on("SIGTERM",()=>{runtime.stop();clearInterval(watch);server.close(()=>process.exit(0))});
}
void main().catch(e=>{console.error(e.message);process.exit(1)});
