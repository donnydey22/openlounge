// Emulates App.tsx: app-owned RTCViews below a transparent WebView appear one bridge hop after a videoLayout record.
const BRIDGE_MS = 60;
export async function nativeMediaCmd(cmd: { op: string; hidden?: boolean }) {
  if (cmd.op !== "videoLayout") return;
  const el = document.getElementById("native-rtc");
  setTimeout(() => { if (el) el.style.visibility = cmd.hidden ? "hidden" : "visible"; }, BRIDGE_MS);
}
