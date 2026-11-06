import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {randomBytes} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import "./env";
import {setTestEnv,startApp,wipeDb,phoneLogin,sql,api,type App} from "../unified-auth/harness";
import {BridgeAuth,BridgeEndpoint,BridgeClient,validateBridgeUrl} from "../../server/calls/bridge/auth";
import {CallingRuntime} from "../../server/calls/bridge/runtime";
setTestEnv({providers:false});
const doKey="calling-test-key-"+"d".repeat(40),platformKey="platform-test-key-"+"p".repeat(40);
const proto={protocol:"ol-rc-v1"};let app:App,dir:string,runtime:CallingRuntime,A:any,B:any,C:any,B2:any,doUrl:string;
const ep=new BridgeEndpoint(new BridgeAuth(doKey,"calling"),(op,a)=>runtime.handle(op,a));
const doServer=createServer((req,res)=>void ep.handle(req,res,"/bridge/calling"));
const actor=(x:any)=>x.res.user.id;let started:any;
const wait=async(f:()=>boolean)=>{for(let n=0;n<100;n++){if(f())return;await new Promise(r=>setTimeout(r,30))}throw Error("wait timeout")};
before(async()=>{
 await wipeDb();dir=await mkdtemp(join(tmpdir(),"ol-crosshost-"));
 await new Promise<void>(r=>doServer.listen(0,"127.0.0.1",r));doUrl="http://127.0.0.1:"+(doServer.address()as any).port+"/bridge/calling";
 Object.assign(process.env,{CALLING_BRIDGE_URL:doUrl,CALLING_TO_DO_KEY:doKey,CALLING_TO_PLATFORM_KEY:platformKey,CALLING_BRIDGE_TEST:"1",TURN_STATIC_SECRET:"test-turn-"+"t".repeat(40)});
 app=await startApp();runtime=new CallingRuntime(new BridgeClient(new URL(app.base+"/api/internal/calling-platform"),new BridgeAuth(platformKey,"platform")),dir);
 const stamp=randomBytes(3).toString("hex");
 A=await phoneLogin(app.wsUrl,"+15555550181",{firstName:"BridgeA",username:"bridgea"+stamp});
 B=await phoneLogin(app.wsUrl,"+15555550182",{firstName:"BridgeB",username:"bridgeb"+stamp});
 C=await phoneLogin(app.wsUrl,"+15555550183",{firstName:"BridgeC",username:"bridgec"+stamp});
 B2=await phoneLogin(app.wsUrl,"+15555550182");
});
after(async()=>{for(const x of[A,B,C,B2])x?.client.close();runtime?.stop();await app?.close();await new Promise<void>(r=>doServer.close(()=>r()));await rm(dir,{recursive:true,force:true});for(const k of["CALLING_BRIDGE_URL","CALLING_TO_DO_KEY","CALLING_TO_PLATFORM_KEY","CALLING_BRIDGE_TEST"])delete process.env[k]});
test("platform bridge mode has no local call lifecycle instance",async()=>{const {calls}=await import("../../server/calls");assert.equal(calls(),null)});
test("bridge authentication rejects raw caller, wrong key, wrong audience and replay",async()=>{
 const body=JSON.stringify({id:"request-auth-0001",op:"health",args:{}});const signer=new BridgeAuth(doKey,"calling");
 assert.equal((await fetch(doUrl,{method:"POST",body})).status,401);
 const bad=new BridgeAuth(platformKey,"calling").headers(body,"/bridge/calling",ep.auth.bootId);
 assert.equal((await fetch(doUrl,{method:"POST",body,headers:bad})).status,401);
 const wrong=new BridgeAuth(doKey,"platform").headers(body,"/bridge/calling",ep.auth.bootId);
 assert.equal((await fetch(doUrl,{method:"POST",body,headers:wrong})).status,401);
 const headers=signer.headers(body,"/bridge/calling",ep.auth.bootId);
 assert.equal((await fetch(doUrl,{method:"POST",body,headers})).status,200);
 assert.equal((await fetch(doUrl,{method:"POST",body,headers})).status,401);
});
test("signed bridge binds request ID to actor/action body and never accepts plaintext signaling",async()=>{
 const signer=new BridgeAuth(doKey,"calling");const body=JSON.stringify({id:"request-binding-0001",op:"health",args:{}});
 assert.equal((await fetch(doUrl,{method:"POST",body,headers:signer.headers(body,"/bridge/calling",ep.auth.bootId)})).status,200);
 const changed=JSON.stringify({id:"request-binding-0001",op:"request",args:{userId:actor(B),connId:"spoof",event:"call:hangup",data:{callId:"whatever"}}});
 assert.equal((await fetch(doUrl,{method:"POST",body:changed,headers:signer.headers(changed,"/bridge/calling",ep.auth.bootId)})).status,409);
 const r=await A.client.req("rtc:signal",{callId:"x",gen:0,seq:0,kind:"offer",sdp:"plain"});assert.equal(r.error,"sealed_signaling_required");
});
test("old-client explicit upgrade gate, authoritative policy, actor cannot be forged in payload",async()=>{
 let r=await A.client.req("call:start",{peerId:actor(B)});assert.equal(r.reason,"upgrade_required");
 r=await A.client.req("call:start",{...proto,peerId:actor(B)});assert.equal(r.ok,false);
 assert.equal((await B.client.req("dm:send",{to:actor(A),text:"permission fixture"})).ok,true);
 started=await A.client.req("call:start",{...proto,peerId:actor(B),userId:actor(C),callerId:actor(C)});assert.equal(started.ok,true,JSON.stringify(started));assert.equal(started.call.callerId,actor(A));assert.equal(started.media.provider,"p2p");assert.ok(started.media.iceServers[0].urls.every((u:string)=>u.includes(":13478")||u.includes(":14443")));
});
test("cross-host outsider denial, first-answer wins, and room occupancy remains authoritative",async()=>{
 const callId=started.call.id;
 assert.equal((await C.client.req("call:accept",{...proto,callId,userId:actor(B)})).ok,false);
 assert.equal((await C.client.req("rc:keys:fetch",{callId,userId:actor(B)})).ok,false);
 assert.equal((await B.client.req("call:accept",{callId})).reason,"upgrade_required");
 assert.equal((await B.client.req("call:accept",{...proto,callId})).ok,true);
 assert.equal((await B2.client.req("call:accept",{...proto,callId})).ok,false);
 const {platformAudioBusy}=await import("../../server/calls/bridge/platform");assert.equal(platformAudioBusy(actor(A)),true);
 const denied=await A.client.req("room:join",{roomId:"any-room"});assert.equal(denied.ok,false);assert.match(denied.error,/Hang up/);
});
test("cross-host hangup releases audio lease and history retries produce exactly one platform message",async()=>{
 assert.equal((await C.client.req("call:hangup",{callId:started.call.id})).ok,false);
 assert.equal((await A.client.req("call:hangup",{callId:started.call.id})).ok,true);
 const {store}=await import("../../server/store");const {platformAudioBusy}=await import("../../server/calls/bridge/platform");
 await wait(()=>!platformAudioBusy(actor(A))&&store.callHistory(actor(A)).calls.some(m=>m.call?.id===started.call.id));
 const message=store.callHistory(actor(A)).calls.find(m=>m.call?.id===started.call.id)!;
 const client=new BridgeClient(new URL(app.base+"/api/internal/calling-platform"),new BridgeAuth(platformKey,"platform"));
 await client.call("history",{meta:message.call,calleeId:actor(B)});await client.call("history",{meta:message.call,calleeId:actor(B)});
 assert.equal(store.callHistory(actor(A)).calls.filter(m=>m.call?.id===started.call.id).length,1);
 assert.equal((await A.client.req("rc:keys:fetch",{callId:started.call.id})).ok,false);
});
test("platform admission survives primary-store reload and atomically excludes room/call races",async()=>{
 const room=await B.client.req("room:create",{title:"Bridge admission fixture"});assert.equal(room.ok,true);
 assert.equal((await B.client.req("room:join",{roomId:room.roomId})).ok,true);
 assert.equal((await A.client.req("call:start",{...proto,peerId:actor(B)})).ok,false);
 await B.client.req("room:leave",{roomId:room.roomId});
 const r=await A.client.req("call:start",{...proto,peerId:actor(B)});assert.equal(r.ok,true);
 const rows=await sql("SELECT user_id,owner,expires_at FROM platform_audio_leases WHERE owner=$1",[r.call.id]);assert.equal(rows.length,2);
 const {PgPersistence}=await import("../../server/pg");const backend=new PgPersistence(process.env.DATABASE_URL!);
 try{assert.equal((await backend.loadAudioLeases()).filter(x=>x.owner===r.call.id).length,2)}finally{await backend.close()}
 await A.client.req("call:hangup",{callId:r.call.id});
 const {platformAudioBusy}=await import("../../server/calls/bridge/platform");await wait(()=>!platformAudioBusy(actor(A)));
 assert.equal((await sql("SELECT user_id FROM platform_audio_leases WHERE owner=$1",[r.call.id])).length,0);
});
test("native HTTP get and single-use token decline preserve participant/callee/active-call boundaries across hosts",async()=>{
 const {declineTokens}=await import("../../server/calls/declineToken");const H=(token:string)=>({headers:{"X-Call-Decline-Token":token}});
 const r=await A.client.req("call:start",{...proto,peerId:actor(B)});assert.equal(r.ok,true);
 const path=`/api/calls/${r.call.id}/decline`;
 assert.equal((await api(app.base,path,{},H(declineTokens().mint(r.call.id,actor(A),r.call.expiresAt)))).status,403);
 assert.equal((await api(app.base,path,{},H(declineTokens().mint(r.call.id,actor(C),r.call.expiresAt)))).status,404);
 const valid=declineTokens().mint(r.call.id,actor(B),r.call.expiresAt);
 assert.equal((await api(app.base,path,{},H(valid))).status,200);
 assert.equal((await api(app.base,path,{},H(valid))).status,409);
 const {platformAudioBusy}=await import("../../server/calls/bridge/platform");await wait(()=>!platformAudioBusy(actor(A)));
 const next=await A.client.req("call:start",{...proto,peerId:actor(B)});assert.equal(next.ok,true);assert.equal((await B.client.req("call:accept",{...proto,callId:next.call.id})).ok,true);
 const token=declineTokens().mint(next.call.id,actor(B),next.call.expiresAt);
 assert.equal((await api(app.base,`/api/calls/${next.call.id}/decline`,{},H(token))).status,409);
 await A.client.req("call:hangup",{callId:next.call.id});await wait(()=>!platformAudioBusy(actor(A)));
});
test("DO authority restart recovers durable call metadata, ends rather than revives sessions, and releases primary audio leases",async()=>{
 const r=await A.client.req("call:start",{...proto,peerId:actor(B)});assert.equal(r.ok,true);
 assert.equal((await B.client.req("call:accept",{...proto,callId:r.call.id})).ok,true);
 runtime.stop();runtime=new CallingRuntime(new BridgeClient(new URL(app.base+"/api/internal/calling-platform"),new BridgeAuth(platformKey,"platform")),dir);
 const {platformAudioBusy}=await import("../../server/calls/bridge/platform");const {store}=await import("../../server/store");
 await wait(()=>!platformAudioBusy(actor(A))&&store.callHistory(actor(A)).calls.some(m=>m.call?.id===r.call.id));
 assert.equal(store.callHistory(actor(A)).calls.find(m=>m.call?.id===r.call.id)?.call?.outcome,"failed");
 assert.equal((await A.client.req("call:get",{callId:r.call.id})).ok,false);
 assert.equal(runtime.recovery.calls.size,0);
});
test("boot epochs reject captured pre-restart traffic; expiry/path/body tampering rejected",()=>{
 let now=1_800_000_000_000;const auth=new BridgeAuth(doKey,"calling",()=>now);const body="{}";const h=auth.headers(body,"/bridge/calling",auth.bootId);
 assert.equal(auth.verify(body,"/other",h),"signature");assert.equal(auth.verify("bad","/bridge/calling",h),"signature");now+=31_000;assert.equal(auth.verify(body,"/bridge/calling",h),"expired");
 assert.equal(new BridgeAuth(doKey,"calling").verify(body,"/bridge/calling",h),"stale_boot");
});
test("production bridge URL validation rejects non-HTTPS, wrong host, port, credentials and arbitrary targets",()=>{
 for(const s of["http://turn.openlounge.app:18443/bridge/calling","https://other.example:18443/bridge/calling","https://u:p@turn.openlounge.app:18443/bridge/calling","https://turn.openlounge.app:4444/bridge/calling","https://127.0.0.1:18443/bridge/calling","https://turn.openlounge.app:18443/anything"])assert.throws(()=>validateBridgeUrl(s,"calling"));
 assert.ok(validateBridgeUrl("https://turn.openlounge.app:18443/bridge/calling","calling"));
});

test("authenticated visibility changes reach the DO authority rather than losing background-ring push behavior",async()=>{
 let seen=false;const original=runtime.service.visibilityChanged.bind(runtime.service);runtime.service.visibilityChanged=u=>{if(u===actor(B))seen=true;original(u)};
 await B.client.req("presence:visible",{visible:true});await B.client.req("presence:visible",{visible:false});await wait(()=>seen);
});
test("invalid cross-host configuration disables only calls, never resurrects a local calling engine or breaks chats",async()=>{
 const old=process.env.CALLING_BRIDGE_URL;try{
  process.env.CALLING_BRIDGE_URL="https://untrusted.example/bridge/calling";
  const {wirePlatformCalls,platformEndpoint}=await import("../../server/calls/bridge/platform");assert.doesNotThrow(()=>wirePlatformCalls({} as any));assert.equal(platformEndpoint(),null);
  const r=await A.client.req("call:start",{...proto,peerId:actor(B)});assert.equal(r.reason,"calling_unavailable");
  assert.equal((await A.client.req("dm:send",{to:actor(B),text:"chat remains available with calling unavailable"})).ok,true);
  assert.equal((await import("../../server/calls")).calls(),null);
 }finally{process.env.CALLING_BRIDGE_URL=old}
});
