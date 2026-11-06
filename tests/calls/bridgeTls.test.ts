import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,renameSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import https from "node:https";
import {CallingTls} from "../../server/calls/bridge/tls";
import {validateBridgeUrl} from "../../server/calls/bridge/auth";
test("TLS renewal atomically rotates new handshakes, preserves established sessions, retains last good pair on invalid renewal",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ol-tls-test-"));const generation=(name:string)=>{const d=join(dir,name);mkdirSync(d);execFileSync("openssl",["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1","-keyout",join(d,"privkey.pem"),"-out",join(d,"fullchain.pem")],{stdio:"ignore"});return d};
 const one=generation("one"),two=generation("two");const current=join(dir,"current");symlinkSync(one,current);const tls=new CallingTls(current);
 const server=https.createServer(tls.options(),(_,res)=>res.end("secure"));await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const url="https://127.0.0.1:"+(server.address()as any).port;
 const agent=new https.Agent({keepAlive:true,ca:readFileSync(join(one,"fullchain.pem"))});
 const get=(agent:https.Agent|false,ca?:Buffer)=>new Promise<string>((resolve,reject)=>{https.get(url,{agent,ca},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>resolve(b))}).on("error",reject)});
 try{
  assert.equal(await get(agent),"secure");assert.equal(tls.reload(server),"updated");
  const broken=join(dir,"broken");mkdirSync(broken);writeFileSync(join(broken,"fullchain.pem"),"broken");writeFileSync(join(broken,"privkey.pem"),"broken");symlinkSync(broken,join(dir,"next"));renameSync(join(dir,"next"),current);assert.equal(tls.reload(server),"invalid");assert.equal(await get(false,readFileSync(join(one,"fullchain.pem"))),"secure");
  symlinkSync(two,join(dir,"next"));renameSync(join(dir,"next"),current);assert.equal(tls.reload(server),"updated");assert.equal(tls.reload(server),"unchanged");
  assert.equal(await get(agent),"secure","existing TLS session survives rotation");assert.equal(await get(false,readFileSync(join(two,"fullchain.pem"))),"secure");await assert.rejects(get(false,readFileSync(join(one,"fullchain.pem"))));
 }finally{agent.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}
});
test("production refuses test-loopback bridge override and demo calling bootstrap",()=>{
 const old=process.env.NODE_ENV;try{Object.assign(process.env,{NODE_ENV:"production"});assert.throws(()=>validateBridgeUrl("http://127.0.0.1:1234/bridge/calling","calling",true))}finally{old===undefined?Reflect.deleteProperty(process.env,"NODE_ENV"):Object.assign(process.env,{NODE_ENV:old})}
 assert.throws(()=>execFileSync(process.execPath,["--import","tsx","scripts/calling-production-server.ts"],{cwd:process.cwd(),env:{...process.env,NODE_ENV:"test"},stdio:"pipe"}),e=>String((e as any).stderr).includes("production environment required"));
});
