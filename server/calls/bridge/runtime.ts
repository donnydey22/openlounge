// DO authority only. Deliberately imports NO platform store, auth providers, DB, Next, APNs or Firebase.
import {CallService} from "../service";
import {RcRelay,PreKeyDirectory} from "../rcRelay";
import {filePreKeyStore} from "../preKeyFileStore";
import {p2pMedia,rtcIceConfig} from "../rtcIceConfig";
import {BridgeClient} from "./auth";
import {CallRecoveryLedger} from "./recovery";
import {PlatformOutbox} from "./outbox";
import {sanitizeSample,callTelemetry} from "../telemetry";
import type {CallPeer,CallInfo} from "../../../src/lib/types";
export const CALL_PROTOCOL="ol-rc-v1";
const valid=(x:unknown):x is string=>typeof x==="string"&&/^[\w-]{1,80}$/.test(x);
export class CallingRuntime {
 readonly service:CallService;readonly relay:RcRelay;readonly outbox:PlatformOutbox;readonly recovery:CallRecoveryLedger;
 private people=new Map<string,{peer:CallPeer,at:number}>();
 private presence=new Map<string,{at:number,connected:boolean,foreground:boolean,count:number}>();
 private policies=new Map<string,any>();private rooms=new Map<string,boolean>();private bindings=new Map<string,string>();
 private queue:Promise<unknown>=Promise.resolve();private effects=new Map<string,Promise<unknown>>();private timer:ReturnType<typeof setInterval>;
 constructor(private platform:BridgeClient,dir:string){
  this.outbox=new PlatformOutbox(dir+"/outbox",platform);this.recovery=new CallRecoveryLedger(dir+"/recovery");
  const emit=(u:string,ev:string,data:any)=>{if(data?.call)this.recovery.observe(data.call);const p=(this.effects.get(u)??Promise.resolve()).catch(()=>{}).then(()=>platform.call("emit",{userId:u,event:ev,data}));this.effects.set(u,p);void p.finally(()=>{if(this.effects.get(u)===p)this.effects.delete(u)}).catch(()=>{});void p.catch(()=>console.warn("[calling] platform delivery unavailable"))};
  const current=(u:string)=>{const p=this.presence.get(u);return p&&Date.now()-p.at<15_000?p:null};
  this.service=new CallService({
   emitUser:emit,isConnected:u=>current(u)?.connected??false,isForeground:u=>current(u)?.foreground??false,connCount:u=>current(u)?.count??0,
   peer:u=>this.people.get(u)?.peer??null,policy:(a,b)=>this.policies.get(a+"|"+b)??{ok:false,error:"Policy unavailable",reason:"policy_unavailable"},inRoom:u=>this.rooms.get(u)??true,
   claimAudio:(callerId,calleeId,owner)=>platform.call("claimAudio",{callerId,calleeId,owner}),
   releaseAudio:(callerId,calleeId,owner)=>this.outbox.put("release-"+owner,"releaseAudio",{owner,users:[callerId,calleeId]}),
   appendCallMessage:(meta,calleeId)=>{this.outbox.put("history-"+meta.id,"history",{meta,calleeId});this.outbox.put("release-"+meta.id,"releaseAudio",{owner:meta.id,users:[meta.callerId,calleeId]});this.recovery.finish(meta.id)},
   selectMedia:()=>({provider:"p2p",issue:async({callId,userId,ttlSec})=>p2pMedia(callId,userId,ttlSec),close:id=>this.relay?.end(id)}),
   push:{incoming:(u,c)=>this.sendPush("incoming",u,c),repush:(u,c)=>this.sendPush("repush",u,c),cancel:(u,id,reason)=>{const c=this.service.peek(id,u);if(c)this.sendPush("cancel",u,c,reason)}},
   log:(msg,extra)=>console.log(JSON.stringify({component:"do-calling",msg,...extra})),
  });
  this.relay=new RcRelay({call:id=>this.service.rtcCall(id),emitUser:emit},new PreKeyDirectory(filePreKeyStore(dir+"/prekeys")));
  // Abrupt authority restart ends old sessions honestly; durable primary history/release retries survive it.
  for(const c of this.recovery.calls.values()){
   const ended={...c,phase:"ended" as const,endedAt:c.endedAt??Date.now(),outcome:c.outcome??"failed" as const};
   this.outbox.put("history-"+c.id,"history",{meta:{id:c.id,callerId:c.callerId,video:c.video,outcome:ended.outcome,durationSec:c.answeredAt?Math.max(0,Math.floor((ended.endedAt-c.answeredAt)/1000)):0},calleeId:c.calleeId});
   this.outbox.put("release-"+c.id,"releaseAudio",{owner:c.id,users:[c.callerId,c.calleeId]});
   for(const u of[c.callerId,c.calleeId])this.outbox.put("restart-"+c.id+"-"+u,"emit",{userId:u,event:"call:state",data:{call:ended,reason:"authority_restart"}});
   this.recovery.finish(c.id);
  }
  this.timer=setInterval(()=>void this.refreshPresence(),3000);this.timer.unref();
 }
 private sendPush(kind:string,userId:string,call:CallInfo,reason?:string){void this.platform.call("push",{kind,userId,call,reason},"push-"+kind+"-"+call.id).catch(()=>console.warn("[calling] platform push unavailable"))}
 private async prepare(a:string,b:string){const p=await this.platform.call("prepare",{callerId:a,calleeId:b});this.policies.set(a+"|"+b,p.policy);for(let n=0;n<2;n++){const uid=n===0?a:b;if(p.peers[n])this.people.set(uid,{peer:p.peers[n],at:Date.now()});this.rooms.set(uid,p.inRoom[n]);this.presence.set(uid,{...p.presence[n],at:Date.now()})}return p.policy}
 private async refreshPresence(){const users=[...this.people.keys()].filter(u=>!!this.service.liveCallOf(u));
  if(users.length)try{const ps=await this.platform.call("presence",{users});for(const p of ps){const was=this.presence.get(p.userId);this.presence.set(p.userId,{...p,at:Date.now()});if(was?.foreground&&!p.foreground)this.service.visibilityChanged(p.userId)}const calls=new Map<string,CallInfo>();for(const u of users){const c=this.service.liveCallOf(u);if(c)calls.set(c.id,c)}for(const c of calls.values()){const r=await this.platform.call("renewAudio",{owner:c.id,users:[c.callerId,c.calleeId]});if(!r.ok)this.service.hangup(c.id,c.callerId)}}catch{console.warn("[calling] platform presence/lease unavailable")}
  for(const k of this.policies.keys()){const[a,b]=k.split("|");if(!this.service.liveCallOf(a)&&!this.service.liveCallOf(b))this.policies.delete(k)}
  for(const[u,p]of this.people)if(Date.now()-p.at>15*60_000&&!this.service.liveCallOf(u)){this.people.delete(u);this.presence.delete(u);this.rooms.delete(u)}
 }
 handle(op:string,a:any):Promise<any>{const p=this.queue.then(()=>this.dispatch(op,a));this.queue=p.catch(()=>{});return p}
 private async dispatch(op:string,a:any){
  if(op==="health")return {ok:true,authority:"digitalocean",sealed:true,pendingEffects:this.outbox.pending};
  if(!a||!valid(a.userId))throw Error("identity");const uid=a.userId;
  if(op==="visibility"){const ps=await this.platform.call("presence",{users:[uid]});for(const p of ps)this.presence.set(p.userId,{...p,at:Date.now()});this.service.visibilityChanged(uid);return {ok:true}}
  if(op==="disconnect"){if(valid(a.connId)&&this.bindings.get(a.connId)===uid){this.service.connClosed(a.connId,uid);this.bindings.delete(a.connId)}return {ok:true}}
  if(op==="tokenDecline"){const c=this.service.peek(a.callId,uid);if(!c||c.calleeId!==uid)return {ok:false,error:"unknown"};if(c.phase==="active")return {ok:false,error:"answered"};return this.service.decline(a.callId,uid)}
  if(op!=="request"||typeof a.event!=="string"||typeof a.data!=="object"||a.data===null||!valid(a.connId))throw Error("request");
  const {event:ev,data:d,connId}=a;
  if((ev==="call:start"||ev==="call:accept")&&a.protocol!==CALL_PROTOCOL)return {ok:false,reason:"upgrade_required",error:"Update Open Lounge at https://openlounge.app/download",downloadUrl:"https://openlounge.app/download"};
  const old=this.bindings.get(connId);if(old&&old!==uid)this.service.connClosed(connId,old);this.bindings.set(connId,uid);
  const id=typeof d.callId==="string"?d.callId:"";
  if(ev==="call:start"){if(!valid(d.peerId))return {ok:false,error:"bad_request"};const pol=await this.prepare(uid,d.peerId);if(!pol.ok)return pol;return this.service.start(uid,d.peerId,d.video===true,connId,false,d.platform)}
  if(ev==="call:accept"){const c=this.service.peek(id,uid);if(!c)return {ok:false,error:"unknown_call"};const pol=await this.prepare(c.callerId,c.calleeId);if(!pol.ok)return pol;return this.service.accept(id,uid,connId,d.platform)}
  if(ev==="call:ack")return this.service.ack(id,uid);
  if(ev==="call:get")return this.service.get_(id,uid,connId.startsWith("http-")?undefined:connId);
  if(ev==="call:current")return {ok:true,call:this.service.liveCallOf(uid)};
  if(ev==="call:hangup")return this.service.hangup(id,uid);
  if(ev==="call:decline"){if(d.tokenDecline){const c=this.service.peek(id,uid);if(!c)return {ok:false,error:"unknown"};if(c.calleeId!==uid)return {ok:false,error:"wrong_user"};if(c.phase==="active")return {ok:false,error:"answered"};}const r=this.service.decline(id,uid);if(r.ok&&typeof d.message==="string"&&d.message.trim()&&"call" in r&&r.call)await this.platform.call("quickReply",{userId:uid,peerId:r.call.callerId,callId:id,message:d.message.trim()});return r}
  if(ev==="call:video")return this.service.setVideo(id,uid,d.on===true);
  if(ev==="call:metric")return this.service.metric(id,uid,d.acceptToAudioMs);
  if(ev==="rc:keys:publish")return this.relay.keys.publish(uid,d);
  if(ev==="rc:keys:fetch")return this.relay.fetchFor(uid,d);
  if(ev==="rc:msg")return this.relay.msg(uid,d);
  if(ev==="rtc:signal")return {ok:false,error:"sealed_signaling_required"};
  const c=this.service.peek(id,uid);if(!c||c.phase==="ended")return {ok:false,error:"not_participant"};
  if(ev==="rtc:iceConfig"||ev==="call:turnRefresh"){const config=rtcIceConfig(id,uid);return ev==="rtc:iceConfig"?{ok:true,config}:{ok:true,iceServers:config.iceServers.filter(s=>"credential" in s)}}
  if(ev==="call:diag"){if(d.ev==="audio-levels")this.service.qualitySample(id,uid,d);return {ok:true}}
  if(ev==="call:telemetry"){const rows=sanitizeSample("client",uid.slice(0,12),d);if(!rows.length)return {ok:false};callTelemetry.add(id,rows);return {ok:true}}
  return {ok:false,error:"unsupported_call_operation"};
 }
 stop(){clearInterval(this.timer);this.service.dispose();this.outbox.stop()}
}
