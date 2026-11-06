import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from "node:fs";
import {join} from "node:path";
import type {BridgeClient} from "./auth";
// Only durable platform history/release/restart-state effects. No private keys, media or sealed session ciphertext stored.
export class PlatformOutbox {
 private jobs=new Map<string,{op:string,args:any}>();private running=false;private stopped=false;private timer:ReturnType<typeof setInterval>;
 constructor(private dir:string,private client:BridgeClient){mkdirSync(dir,{recursive:true,mode:0o700});try{this.jobs=new Map(JSON.parse(readFileSync(join(dir,"effects.json"),"utf8")))}catch(e:any){if(e.code!=="ENOENT")throw e}this.timer=setInterval(()=>void this.flush(),2000);this.timer.unref();void this.flush()}
 private save(){const p=join(this.dir,"effects.json");writeFileSync(p+".tmp",JSON.stringify([...this.jobs]),{mode:0o600});const fd=openSync(p+".tmp","r");try{fsyncSync(fd)}finally{closeSync(fd)}renameSync(p+".tmp",p);const dd=openSync(this.dir,"r");try{fsyncSync(dd)}finally{closeSync(dd)}}
 put(id:string,op:string,args:any){this.jobs.set(id,{op,args});this.save();void this.flush()}
 async flush(){if(this.running||this.stopped)return;this.running=true;try{for(const[id,j]of this.jobs){try{await this.client.call(j.op,j.args,id);if(this.stopped)return;this.jobs.delete(id);this.save()}catch{continue}}}finally{this.running=false}}
 stop(){this.stopped=true;clearInterval(this.timer)}
 get pending(){return this.jobs.size}
}
