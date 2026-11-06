import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BridgeAuth,BridgeClient,BridgeEndpoint,MAX_BRIDGE_BYTES} from "../../server/calls/bridge/auth";
import {PlatformOutbox} from "../../server/calls/bridge/outbox";
import {nativeCallingProtocolAvailable} from "../../src/lib/calls/nativeMediaSession";
const key="security-unit-test-"+"k".repeat(40);
test("native browser fallback cannot claim the new production protocol without the upgraded shell capability",()=>{
 const w=(globalThis as any).window;try{
  (globalThis as any).window={OpenLoungeNativeMedia:{nativeMedia:()=>{},msReply:()=>{},capabilities:["nativeMedia","rtcP2P"]}};assert.equal(nativeCallingProtocolAvailable(),false);
  (globalThis as any).window.OpenLoungeNativeMedia.capabilities.push("ol-rc-v1");assert.equal(nativeCallingProtocolAvailable(),true);
 }finally{if(w===undefined)delete(globalThis as any).window;else(globalThis as any).window=w}
});
test("all bridge auth fields are required, future requests expire and signature binds body and endpoint",()=>{
 let now=1_800_000_000_000;const a=new BridgeAuth(key,"calling",()=>now),body="{}";
 for(const field of["x-ol-time","x-ol-nonce","x-ol-signature","x-ol-boot"]){const h:any=a.headers(body,"/bridge/calling",a.bootId);delete h[field];assert.ok(a.verify(body,"/bridge/calling",h))}
 const h=a.headers(body,"/bridge/calling",a.bootId);now-=31_000;assert.equal(a.verify(body,"/bridge/calling",h),"expired");now+=31_000;
 assert.equal(a.verify("changed","/bridge/calling",h),"signature");assert.equal(a.verify(body,"/api/internal/calling-platform",h),"signature");assert.equal(a.verify(body,"/bridge/calling",h),null);assert.equal(a.verify(body,"/bridge/calling",h),"replayed");
});
test("signed stable request retries recover after transient operation failure, execute once after success, and bind exact path/body",async()=>{
 let attempts=0;const auth=new BridgeAuth(key,"calling");const ep=new BridgeEndpoint(auth,async()=>{attempts++;if(attempts===1)throw Error("transient");return {ok:true}});
 const s=createServer((req,res)=>void ep.handle(req,res,"/bridge/calling"));await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const url=new URL("http://127.0.0.1:"+(s.address()as any).port+"/bridge/calling");const client=new BridgeClient(url,new BridgeAuth(key,"calling"));
 try{
  assert.deepEqual(await client.call("once",{},"stable-request-0001"),{ok:true});assert.equal(attempts,2);await client.call("once",{},"stable-request-0001");assert.equal(attempts,2);
  await assert.rejects(client.call("other",{},"stable-request-0001"));assert.equal(attempts,2);
  assert.equal((await fetch(new URL("/other",url))).status,404);
  assert.equal((await fetch(url,{method:"POST",body:"x".repeat(MAX_BRIDGE_BYTES+1)})).status,413);
  const body="null";assert.equal((await fetch(url,{method:"POST",body,headers:auth.headers(body,url.pathname,auth.bootId)})).status,400);
 }finally{s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()))}
});
test("durable effects retry history independently of audio release and survive authority restart",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ol-outbox-test-"));let historyAvailable=false;const got:string[]=[];const fake={call:async(op:string)=>{if(op==="history"&&!historyAvailable)throw Error("primary unavailable");got.push(op);return {ok:true}}}as unknown as BridgeClient;
 const wait=async(f:()=>boolean)=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,10))}throw Error("timed out")};let box=new PlatformOutbox(dir,fake);
 try{box.put("history-outbox-0001","history",{meta:{id:"id"}});box.put("release-outbox-0001","releaseAudio",{owner:"id"});await wait(()=>got.includes("releaseAudio"));assert.equal(box.pending,1);box.stop();historyAvailable=true;box=new PlatformOutbox(dir,fake);await wait(()=>box.pending===0);assert.equal(got.filter(x=>x==="history").length,1)}finally{box.stop();await rm(dir,{recursive:true,force:true})}
});
