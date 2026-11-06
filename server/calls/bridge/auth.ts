// Mutually authenticated server bridge. No browser/session token grants bridge authority.
import {createHash,createHmac,randomBytes,timingSafeEqual,randomUUID} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";
export const MAX_BRIDGE_BYTES=256*1024;
export class BridgeAuth {
 readonly bootId=randomBytes(24).toString("hex");
 private seen=new Map<string,number>();
 constructor(private key:string,private audience:string,private now:()=>number=Date.now){if(Buffer.byteLength(key)<32)throw Error("strong bridge key required")}
 headers(body:string,path:string,bootId:string){const time=String(this.now()),nonce=randomBytes(24).toString("hex");return {"content-type":"application/json","x-ol-time":time,"x-ol-nonce":nonce,"x-ol-boot":bootId,"x-ol-signature":this.sign(body,path,time,nonce,bootId)}}
 private sign(body:string,path:string,time:string,nonce:string,boot:string){return createHmac("sha256",this.key).update(["OLBridge-v1",this.audience,"POST",path,time,nonce,boot,createHash("sha256").update(body).digest("hex")].join("\n")).digest("hex")}
 verify(body:string,path:string,h:Record<string,unknown>){const time=h["x-ol-time"],nonce=h["x-ol-nonce"],boot=h["x-ol-boot"],sig=h["x-ol-signature"];
  if(typeof time!=="string"||!/^\d{13}$/.test(time)||typeof nonce!=="string"||! /^[a-f0-9]{48}$/.test(nonce)||typeof sig!=="string"||! /^[a-f0-9]{64}$/.test(sig))return "malformed";
  if(boot!==this.bootId)return "stale_boot";
  if(Math.abs(this.now()-Number(time))>30_000)return "expired";
  const want=this.sign(body,path,time,nonce,boot as string);if(!timingSafeEqual(Buffer.from(sig,"hex"),Buffer.from(want,"hex")))return "signature";
  for(const[k,v]of this.seen)if(v<this.now())this.seen.delete(k);
  if(this.seen.has(nonce))return "replayed";
  if(this.seen.size>=100_000)return "overloaded";
  this.seen.set(nonce,this.now()+60_000);return null;
 }
}
export function validateBridgeUrl(raw:string,side:"calling"|"platform",test=false){const u=new URL(raw);const local=["127.0.0.1","localhost","[::1]"].includes(u.hostname);if(u.username||u.password||u.search||u.hash)throw Error("invalid bridge URL");if(test&&process.env.NODE_ENV!=="production"&&local&&u.protocol==="http:")return u;
 if(u.pathname!==(side==="calling"?"/bridge/calling":"/api/internal/calling-platform"))throw Error("invalid bridge path");
 if(u.protocol!=="https:"||u.hostname!==(side==="calling"?"turn.openlounge.app":"openlounge.app")||(side==="calling"?u.port!=="18443":!!u.port))throw Error("bridge must use pinned production HTTPS endpoint");return u;}
export class BridgeClient {
 private boot:string|null=null;
 constructor(private url:URL,private auth:BridgeAuth){}
 async call(op:string,args:unknown,id:string=randomUUID()):Promise<any>{
  const body=JSON.stringify({id,op,args});if(Buffer.byteLength(body)>MAX_BRIDGE_BYTES)throw Error("bridge payload too large");const deadline=Date.now()+8500;
  let failure:unknown;for(let i=0;i<3;i++){try{
   const timeout=()=>AbortSignal.timeout(Math.max(1,Math.min(4000,deadline-Date.now())));
   if(Date.now()>=deadline)break;
   if(!this.boot){const r=await fetch(this.url,{signal:timeout(),redirect:"error"});if(!r.ok)throw Error("bridge discovery unavailable");const boot=(await r.json()).bootId;if(typeof boot!=="string"||!/^[a-f0-9]{48}$/.test(boot))throw Error("bad bridge discovery");this.boot=boot}
   const r=await fetch(this.url,{method:"POST",headers:this.auth.headers(body,this.url.pathname,this.boot),body,signal:timeout(),redirect:"error"});const result=await r.json();
   if(result.error==="stale_boot"){this.boot=null;continue}if(!r.ok){if(r.status!==503)throw Object.assign(Error("bridge rejected "+r.status),{permanent:true});throw Error("bridge operation unavailable")}return result.result;
  }catch(e:any){if(e.permanent)throw e;failure=e;if(Date.now()<deadline)await new Promise(r=>setTimeout(r,100*(i+1)))}}
  throw failure??Error("bridge boot changed");
 }
}
export function json(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(body))}
export class BridgeEndpoint {
 private bad=new Map<string,{at:number,count:number}>();
 private replies=new Map<string,{at:number,hash:string,p:Promise<unknown>}>();
 constructor(readonly auth:BridgeAuth,private dispatch:(op:string,args:any)=>Promise<unknown>){}
 async handle(req:IncomingMessage,res:ServerResponse,path:string){const ip=req.socket.remoteAddress??"unknown";for(const[k,v]of this.bad)if(v.at<Date.now()-60_000)this.bad.delete(k);if((this.bad.get(ip)?.count??0)>=60)return json(res,429,{error:"rate"});if(req.url!==path)return json(res,404,{error:"path"});if(req.method==="GET")return json(res,200,{ok:true,bootId:this.auth.bootId});if(req.method!=="POST")return json(res,405,{error:"method"});
  let body="";try{const chunks:Buffer[]=[];let bytes=0;for await(const c of req){const b=Buffer.isBuffer(c)?c:Buffer.from(c);bytes+=b.length;if(bytes>MAX_BRIDGE_BYTES)return json(res,413,{error:"too_large"});chunks.push(b)}body=Buffer.concat(chunks).toString("utf8")}catch{return json(res,400,{error:"body"})}
  const e=this.auth.verify(body,path,req.headers);if(e){const b=this.bad.get(ip)??{at:Date.now(),count:0};b.count++;if(this.bad.size<10_000||this.bad.has(ip))this.bad.set(ip,b);return json(res,e==="stale_boot"?409:401,{error:e})}this.bad.delete(ip);
  let m:any;try{m=JSON.parse(body)}catch{return json(res,400,{error:"json"})}if(!m||typeof m!=="object"||Array.isArray(m)||typeof m.id!=="string"||!/^[a-zA-Z0-9_-]{8,100}$/.test(m.id)||typeof m.op!=="string")return json(res,400,{error:"request"});
  for(const[k,v]of this.replies)if(v.at<Date.now()-120_000)this.replies.delete(k);
  if(this.replies.size>100_000)return json(res,503,{error:"overloaded"});
  let cached=this.replies.get(m.id);const hash=createHash("sha256").update(body).digest("hex");if(cached&&cached.hash!==hash)return json(res,409,{error:"request_id_conflict"});if(!cached){cached={at:Date.now(),hash,p:Promise.resolve().then(()=>this.dispatch(m.op,m.args))};this.replies.set(m.id,cached)}
  try{return json(res,200,{result:await cached.p})}catch{if(this.replies.get(m.id)===cached)this.replies.delete(m.id);return json(res,503,{error:"operation_failed"})}
 }
}
