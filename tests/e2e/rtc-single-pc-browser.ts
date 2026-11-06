// Real headless-browser WebRTC integration; synthetic capture is NOT physical device/audio proof.
import { CallSession } from "../../src/lib/calls/rtc/CallSession";
import { SealedSignaling, OlKeyStore, memoryKv } from "../../src/lib/calls/ringrtc";
import { RcRelay } from "../../server/calls/rcRelay";

(globalThis as any).runRtcMatrix = async () => {
  const handlers: Record<string, Record<string, Set<(d: any) => void>>> = {a:{},b:{}};
  const relay = new RcRelay({ call: id => id === "headless" ? {callerId:"a",calleeId:"b",phase:"active"} : null,
    emitUser: (uid,ev,d) => { for(const h of handlers[uid][ev] ?? []) queueMicrotask(()=>h(d)); } });
  const socket = (uid: string) => ({
    on:(ev:string,h:(d:any)=>void)=>{(handlers[uid][ev] ??= new Set()).add(h)},
    off:(ev:string,h:(d:any)=>void)=>{handlers[uid][ev]?.delete(h)},
    request:async<T>(ev:string,d:any):Promise<T> => (console.log("req",uid,ev,d?.kind??""), ev === "rc:keys:publish" ? await relay.keys.publish(uid,d) : ev === "rc:keys:fetch" ? await relay.fetchFor(uid,d) : ev === "rc:msg" ? relay.msg(uid,d) : {ok:true,config:{iceServers:config.iceServers ?? []}}) as T,
  });
  const ka = new OlKeyStore(memoryKv()), kb = new OlKeyStore(memoryKv());
  const aSock=socket("a"), bSock=socket("b");
  await aSock.request("rc:keys:publish",await ka.publishable());
  await bSock.request("rc:keys:publish",await kb.publishable());
  const sealedA=new SealedSignaling(aSock,ka,{callId:"headless",role:"caller",peerUserId:"b"});
  const sealedB=new SealedSignaling(bSock,kb,{callId:"headless",role:"callee",peerUserId:"a"});
  const errors:any[]=[];
  const config=(globalThis as any).RTC_MATRIX_CONFIG ?? {};
  const createPeer=(cfg: RTCConfiguration)=>new RTCPeerConnection({...cfg,...config});
  const a=new CallSession(sealedA,{callId:"headless",role:"caller",media:{provider:"p2p",url:"rtc",token:"",callId:"headless",expiresAt:9999999999},log:(ev,d)=>console.log(ev,JSON.stringify(d)),createPeer,onFailure:e=>{errors.push(String(e));console.log("FAIL",String(e))}});
  const b=new CallSession(sealedB,{callId:"headless",role:"callee",media:{provider:"p2p",url:"rtc",token:"",callId:"headless",expiresAt:9999999999},log:(ev,d)=>console.log(ev,JSON.stringify(d)),createPeer,onFailure:e=>{errors.push(String(e));console.log("FAIL",String(e))}});
  (globalThis as any).rtcDebug={a,b};
  const wait=async(f:()=>boolean)=>{const until=Date.now()+15000;while(!f()){if(Date.now()>until)throw Error("matrix timeout");await new Promise(r=>setTimeout(r,50))}};
  let timer: ReturnType<typeof setInterval> | undefined;
  let v: MediaStreamTrack | undefined;
  try {
    await Promise.race([Promise.all([b.start(),a.start()]),new Promise((_,rej)=>setTimeout(()=>rej(Error("ICE timeout")),20000))]);
    const pa=a.peer!,pb=b.peer!;
    const slotCounts=[pa,pb].map(p=>p.getTransceivers().filter(t=>t.receiver.track.kind==="video").length);
    if(slotCounts.some(n=>n!==1)) throw Error("not exactly one video slot: "+slotCounts);
    const canvas=document.createElement("canvas");canvas.width=320;canvas.height=240;
    const ctx=canvas.getContext("2d")!;let frame=0;
    timer=setInterval(()=>{ctx.fillStyle=frame++%2?"red":"blue";ctx.fillRect(0,0,320,240)},33);
    v=canvas.captureStream(15).getVideoTracks()[0];
    await a.setVideoTrack(v); await b.setVideoTrack(v.clone());
    let stats:any[]=[];
    await wait(()=>frame>30);
    for(const p of [pa,pb]){const rows=[...(await p.getStats()).values()];stats.push(rows.filter((r:any)=>r.type==="inbound-rtp"||r.type==="outbound-rtp"));}
    for(const rows of stats){if(!rows.some((r:any)=>r.type==="inbound-rtp"&&r.kind==="audio"&&r.bytesReceived>0))throw Error("no inbound audio packets");if(!rows.some((r:any)=>r.type==="inbound-rtp"&&r.kind==="video"&&r.framesDecoded>0))throw Error("no decoded inbound video");}
    await a.setVideoTrack(null); await b.setVideoTrack(null);
    await a.setVideoTrack(v);await b.setVideoTrack(v.clone());
    if(a.peer!==pa||b.peer!==pb) throw Error("camera toggle replaced PC");
    const selected=[];
    for(const p of [pa,pb]){const all=await p.getStats();const transport=[...all.values()].find((s:any)=>s.type==="transport"&&s.selectedCandidatePairId);const pair=transport?all.get(transport.selectedCandidatePairId):null;const local=pair?all.get(pair.localCandidateId):null;if(config.iceTransportPolicy==="relay"&&local?.candidateType!=="relay")throw Error("forced-relay selected non-relay candidate");selected.push({localType:local?.candidateType,protocol:local?.protocol,relayProtocol:local?.relayProtocol});}
    const ufrag=(d:RTCSessionDescription|null)=>d?.sdp.match(/a=ice-ufrag:(.+)/)?.[1];
    const before=ufrag(pa.localDescription);
    window.dispatchEvent(new Event("online")); // synthetic network-change notification, NOT a Wi-Fi/cellular handoff
    await wait(()=>ufrag(pa.localDescription)!==before && ufrag(pa.localDescription)===ufrag(pb.remoteDescription) && ufrag(pb.localDescription)===ufrag(pa.remoteDescription) && pa.signalingState==="stable" && pb.signalingState==="stable" && [pa,pb].every(p=>p.iceGatheringState==="complete"&&(p.iceConnectionState==="connected"||p.iceConnectionState==="completed")));
    await new Promise(r=>setTimeout(r,600));
    const after=[];
    for(const [i,p] of [pa,pb].entries()){const rows=[...(await p.getStats()).values()].filter((r:any)=>r.type==="inbound-rtp");for(const kind of ["audio","video"]){const old=stats[i].find((r:any)=>r.type==="inbound-rtp"&&r.kind===kind);const next=rows.find((r:any)=>r.kind===kind);if(!next||next.bytesReceived<=old.bytesReceived)throw Error("no packet progress after ICE restart: "+kind);}after.push(rows);}

    if(a.peer!==pa||b.peer!==pb) throw Error("ICE restart replaced PC");
    if(errors.length) throw Error("RTC errors: "+errors.join(","));
    return {synthetic:true, physicalDeviceTest:false,states:[a.state,b.state],slotCounts,errors,stats,afterRestartStats:after,selected,syntheticOnlineIceRestart:true};
  } finally {if(timer)clearInterval(timer);v?.stop();console.log("final",a.peer?.signalingState,b.peer?.signalingState,a.peer?.iceConnectionState,b.peer?.iceConnectionState,JSON.stringify(errors),JSON.stringify([a.peer,b.peer].map(p=>({gathering:p?.iceGatheringState,candidates:(p?.localDescription?.sdp.match(/a=candidate/g)??[]).length}))));a.close();b.close();}
};
