import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from "node:fs";
import {join} from "node:path";
import type {CallInfo} from "../../../src/lib/types";
/** DO-owned recovery metadata only. Never session secrets, SDP, credentials or sealed messages. */
export class CallRecoveryLedger {
 readonly calls=new Map<string,CallInfo>();
 constructor(private dir:string){mkdirSync(dir,{recursive:true,mode:0o700});try{for(const c of JSON.parse(readFileSync(join(dir,"active-calls.json"),"utf8"))){if(!c||typeof c.id!=="string"||typeof c.callerId!=="string"||typeof c.calleeId!=="string")throw Error("invalid call recovery metadata");this.calls.set(c.id,c)}}catch(e:any){if(e.code!=="ENOENT")throw e}}
 private save(){const p=join(this.dir,"active-calls.json");writeFileSync(p+".tmp",JSON.stringify([...this.calls.values()]),{mode:0o600});for(const f of[p+".tmp"]){const fd=openSync(f,"r");try{fsyncSync(fd)}finally{closeSync(fd)}}renameSync(p+".tmp",p);const fd=openSync(this.dir,"r");try{fsyncSync(fd)}finally{closeSync(fd)}}
 observe(call:CallInfo){this.calls.set(call.id,call);this.save()}
 finish(id:string){this.calls.delete(id);this.save()}
}
