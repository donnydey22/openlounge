// Existing platform only: authentication/policy/store/push stay authoritative here. NO call state machine.
import {randomUUID} from "node:crypto";
import type {Conn,WsHub} from "../../ws";
import {store} from "../../store";
import {push,bg} from "../../push";
import {initVoip,voipService} from "../voip";
import {declineTokens} from "../declineToken";
import {BridgeAuth,BridgeClient,BridgeEndpoint,validateBridgeUrl} from "./auth";
export const PLATFORM_BRIDGE_PATH="/api/internal/calling-platform";
export const CALL_PROTOCOL="ol-rc-v1";
export const bridgeMode=()=>process.env.NODE_ENV==="production"||!!process.env.CALLING_BRIDGE_URL;
let io:WsHub|null=null,client:BridgeClient|null=null,endpoint:BridgeEndpoint|null=null;
const leases=store.audioAdmissionLeases;
const uid=(v:unknown):v is string=>typeof v==="string"&&/^[\w-]{1,80}$/.test(v);
export function platformAudioBusy(user:string){const l=leases.get(user);if(l&&l.until>Date.now())return true;if(l)leases.delete(user);return false}
export function platformCallingVisibility(userId:string){if(client)void client.call("visibility",{userId}).catch(()=>{})}
export function platformEndpoint(){return endpoint}
export async function remoteCall(userId:string,connId:string,event:string,data:any={},protocol=CALL_PROTOCOL,requestId?:string){if(!client)return {ok:false,error:"Calls are temporarily unavailable",reason:"calling_unavailable"};return client.call("request",{userId,connId,event,data,protocol},requestId)}
const UPGRADE={ok:false,error:"Update Open Lounge at https://openlounge.app/download to use calls",reason:"upgrade_required",downloadUrl:"https://openlounge.app/download",requiredProtocol:CALL_PROTOCOL};
const EVENTS=["call:start","call:accept","call:ack","call:decline","call:hangup","call:get","call:current","call:video","call:metric","call:diag","call:telemetry","call:turnRefresh","rtc:iceConfig","rtc:signal","rc:msg","rc:keys:publish","rc:keys:fetch"];
export function attachPlatformCalls(socket:Conn,authed:(ack:any,fn:(uid:string)=>void)=>void){let last:string|null=null;
 for(const event of EVENTS)socket.on(event,(data:any={},ack:any=()=>{})=>authed(ack,user=>{last=user;
  if((event==="call:start"||event==="call:accept")&&data?.protocol!==CALL_PROTOCOL)return ack(UPGRADE);
  void remoteCall(user,socket.id,event,data,data?.protocol??"").then(ack,()=>ack({ok:false,error:"Calls are temporarily unavailable",reason:"calling_unavailable"}));
 }));
 socket.on("call:history",({before}:any={},ack:any=()=>{})=>authed(ack,user=>{const h=store.callHistory(user,before);const peers:Record<string,unknown>={};for(const m of h.calls){const p=m.fromId===user?m.toId:m.fromId;peers[p]=store.publicUser(p)}ack({ok:true,...h,peers})}));
 socket.onClose(()=>{if(last&&client)void client.call("disconnect",{userId:last,connId:socket.id}).catch(()=>{})});
}
export function wirePlatformCalls(hub:WsHub){io=hub;if(!voipService())initVoip({log:()=>{}});
 const outbound=process.env.CALLING_TO_DO_KEY??"",inbound=process.env.CALLING_TO_PLATFORM_KEY??"";
 if(!process.env.CALLING_BRIDGE_URL||outbound.length<32||inbound.length<32||outbound===inbound){client=null;endpoint=null;console.warn("[calling-bridge] unavailable; no local calling engine started");return}
 try{client=new BridgeClient(validateBridgeUrl(process.env.CALLING_BRIDGE_URL,"calling",process.env.CALLING_BRIDGE_TEST==="1"),new BridgeAuth(outbound,"calling"))}catch{client=null;endpoint=null;console.error("[calling-bridge] invalid configuration; calls disabled without affecting platform");return}
 endpoint=new BridgeEndpoint(new BridgeAuth(inbound,"platform"),async(op,a)=>{
  if(!a||typeof a!=="object")throw Error("bad_args");
  if(op==="prepare"){
   if(!uid(a.callerId)||!uid(a.calleeId))throw Error("identity");
   const users=[a.callerId,a.calleeId];return {policy:store.callPolicy(a.callerId,a.calleeId),peers:users.map(id=>store.publicUser(id)),presence:users.map(id=>presence(id)),inRoom:users.map(id=>store.currentRoomOf(id)!==null)};
  }
  if(op==="presence") {if(!Array.isArray(a.users)||a.users.length>500||!a.users.every(uid))throw Error("identity");return a.users.map(presence)}
  if(op==="claimAudio"){
   if(!uid(a.callerId)||!uid(a.calleeId)||!uid(a.owner))throw Error("identity");const users=[a.callerId,a.calleeId];
   const policy=store.callPolicy(a.callerId,a.calleeId);if(!policy.ok)return policy;
   if(users.some(id=>store.currentRoomOf(id)!==null||(platformAudioBusy(id)&&leases.get(id)?.owner!==a.owner)))return {ok:false,reason:"audio_busy",error:"A participant is already using audio"};
   const previous=users.map(id=>leases.get(id)),until=Date.now()+120_000;for(const id of users)leases.set(id,{owner:a.owner,until});
   try{await store.flush(true);if(!await store.persistAudioAdmission(a.owner,users,until))throw Error("durable audio conflict")}catch(e){for(let n=0;n<users.length;n++){const id=users[n],l=leases.get(id);if(l&&l.owner===a.owner&&l.until===until){const old=previous[n];if(old)leases.set(id,old);else leases.delete(id)}}throw e}
   return {ok:true};
  }
  if(op==="renewAudio"||op==="releaseAudio"){
   if(!uid(a.owner)||!Array.isArray(a.users)||a.users.length!==2||!a.users.every(uid))throw Error("lease");
   if(op==="renewAudio"&&a.users.some((id:string)=>store.currentRoomOf(id)!==null||(platformAudioBusy(id)&&leases.get(id)?.owner!==a.owner)))return {ok:false,error:"audio_lease_lost"};
   const until=op==="releaseAudio"?0:Date.now()+120_000;
   if(!await store.persistAudioAdmission(a.owner,a.users,until))return {ok:false,error:"audio_lease_lost"};
   for(const id of a.users){const l=leases.get(id);if(until)leases.set(id,{owner:a.owner,until});else if(l?.owner===a.owner)leases.delete(id)}return {ok:true};
  }
  if(op==="emit"){
   if(!uid(a.userId)||!["call:incoming","call:state","call:peer","call:video","rc:msg"].includes(a.event))throw Error("event");io?.to("user:"+a.userId).emit(a.event,a.data);return {ok:true};
  }
  if(op==="history"){
   const m=a.meta;if(!m||!uid(m.id)||!uid(m.callerId)||!uid(a.calleeId)||!store.publicUser(m.callerId)||!store.publicUser(a.calleeId)||!["completed","declined","failed","missed","cancelled","busy"].includes(m.outcome))throw Error("history");
   if(m.callerId===a.calleeId||typeof m.video!=="boolean"||!Number.isInteger(m.durationSec)||m.durationSec<0||m.durationSec>604800)throw Error("history_fields");
   store.appendCallMessage(m,a.calleeId);await store.flush(true);return {ok:true};
  }
  if(op==="quickReply"){if(!uid(a.userId)||!uid(a.peerId)||!uid(a.callId)||typeof a.message!=="string")throw Error("reply");const r=store.sendDm(a.userId,a.peerId,a.message.slice(0,500),"call-reply-"+a.callId);if(r.ok)await store.flush(true);return r}
  if(op==="push"){
   if(!uid(a.userId)||!a.call||!uid(a.call.id)||!uid(a.call.callerId)||a.call.calleeId!==a.userId||!["incoming","repush","cancel"].includes(a.kind))throw Error("push");
   const c=a.call;if(a.kind==="cancel"){await push()?.callCancel(a.userId,c.id,a.reason??"ended");return {ok:true}}
   if(c.expiresAt<Date.now()||c.expiresAt>Date.now()+120_000) return {ok:true,expired:true};
   const token=declineTokens().mint(c.id,a.userId,c.expiresAt);
   let rang=0;
   if(a.kind==="incoming")rang=await(voipService()?.ring(a.userId,{type:"call_incoming",callId:c.id,callerId:c.callerId,callerName:c.caller.name,callerPhoto:c.caller.photoUrl?.startsWith("http")?c.caller.photoUrl:"",video:c.video?"1":"0",expiresAt:String(c.expiresAt),url:"/call/"+c.id,declineToken:token},c.expiresAt)??Promise.resolve(0)).catch(()=>0);
   await push()?.callIncoming(a.userId,c,{skipIos:rang>0||a.kind==="repush",declineToken:token});return {ok:true};
  }
  throw Error("unsupported_platform_operation");
 });
}
function presence(userId:string){const conns=[...(io?.members("user:"+userId)??[])];return {userId,connected:conns.length>0,foreground:conns.some(c=>!c.hidden),count:conns.length}}
