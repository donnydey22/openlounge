import {readFileSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createSecureContext,type SecureContextOptions} from "node:tls";
/** Resolve the atomically switched directory once, so cert/key always come from one renewal generation. */
export class CallingTls {
 private digest="";
 constructor(private directory:string){}
 options():SecureContextOptions {const dir=realpathSync(this.directory);return {cert:readFileSync(join(dir,"fullchain.pem")),key:readFileSync(join(dir,"privkey.pem")),minVersion:"TLSv1.2"}}
 reload(server:{setSecureContext(options:SecureContextOptions):void}){try{const o=this.options();const hash=createHash("sha256").update(o.cert as Buffer).update(o.key as Buffer).digest("hex");if(hash===this.digest)return "unchanged";createSecureContext(o);server.setSecureContext(o);this.digest=hash;return "updated"}catch{return "invalid"}}
}
