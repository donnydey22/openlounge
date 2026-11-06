// Explicit isolated candidate smoke. Refuses production targets and never sends real provider messages.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { phoneLogin } from "../tests/unified-auth/harness";
import { OlKeyStore, memoryKv, SealedSignaling } from "../src/lib/calls/ringrtc";
async function main(){
const health=await(await fetch("http://127.0.0.1:3102/candidate-health")).json();assert.equal(health.production,false);
const stamp=Date.now().toString().slice(-7);
const a=await phoneLogin("ws://127.0.0.1:3102/ws","+1555"+stamp,{firstName:"CandidateA",username:"rca"+stamp});
const b=await phoneLogin("ws://127.0.0.1:3102/ws","+1556"+stamp,{firstName:"CandidateB",username:"rcb"+stamp});
const c=await phoneLogin("ws://127.0.0.1:3102/ws","+1557"+stamp,{firstName:"CandidateC",username:"rcc"+stamp});
try{
 await b.client.req("dm:send",{to:a.res.user.id,text:"isolated candidate fixture"});
 const started=await a.client.req("call:start",{peerId:b.res.user.id});assert.ok(started.ok,JSON.stringify(started));const callId=started.call.id;
 assert.equal((await b.client.req("call:accept",{callId})).ok,true);
 const ice=await a.client.req("rtc:iceConfig",{callId});assert.equal(ice.ok,true);
 const turn=ice.config.iceServers.find((s:any)=>s.credential);assert.ok(turn);assert.ok(turn.urls.every((u:string)=>u.includes(":13478")||u.includes(":14443")));
 if(process.env.RC_SMOKE_ICE_OUTPUT)await fs.writeFile(process.env.RC_SMOKE_ICE_OUTPUT,JSON.stringify({iceServers:[turn],iceTransportPolicy:"relay"}),{mode:0o600});
 const adapter=(client:any)=>{const map=new Map<any,any>();return{request:client.req,on:(ev:string,fn:any)=>{const h=(raw:any)=>{const m=JSON.parse(raw.toString());if(m.t==="evt"&&m.ev===ev)fn(m.data)};map.set(fn,h);client.ws.on("message",h)},off:(_ev:string,fn:any)=>{client.ws.off("message",map.get(fn));map.delete(fn)}}};
 const ka=new OlKeyStore(memoryKv()),kb=new OlKeyStore(memoryKv());
 assert.equal((await a.client.req("rc:keys:publish",await ka.publishable())).ok,true);
 assert.equal((await b.client.req("rc:keys:publish",await kb.publishable())).ok,true);
 assert.equal((await c.client.req("rc:keys:fetch",{callId})).ok,false);
 const A=new SealedSignaling(adapter(a.client),ka,{callId,role:"caller",peerUserId:b.res.user.id});
 const B=new SealedSignaling(adapter(b.client),kb,{callId,role:"callee",peerUserId:a.res.user.id});
 let resolve:any;const received=new Promise(r=>resolve=r);B.on("rtc:signal",d=>resolve(d));
 await A.request("rtc:signal",{callId,gen:0,seq:0,kind:"offer",sdp:"candidate-test-only"});
 const msg:any=await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(Error("sealed relay timeout")),8000))]);assert.equal(msg.sdp,"candidate-test-only");
 A.close();B.close();assert.equal((await a.client.req("call:hangup",{callId})).ok,true);
 assert.equal((await a.client.req("rc:keys:fetch",{callId})).ok,false);
 console.log(JSON.stringify({ok:true,production:false,auth:true,participantScope:true,sealedRelay:true,endedCallDenied:true,persistentPublicKeys:true,pionIceConfig:true}));
}finally{a.client.close();b.client.close();c.client.close()}
}
void main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
