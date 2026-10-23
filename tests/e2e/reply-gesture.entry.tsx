import { createRoot } from "react-dom/client";
import { ReplyGesture } from "../../src/components/chat/ReplyGesture";

function Harness() {
  const replies: string[] = [];
  const mark = (name: string) => {
    replies.push(name);
    const log = document.querySelector<HTMLElement>("[data-testid=reply-log]");
    if (log) log.textContent = replies.join(",");
  };
  const item = (id: string, child: React.ReactNode) => (
    <section id={`${id}-gesture`} data-gesture={id} style={{ margin: 8, padding: 6, border: "1px solid #333" }}>
      <ReplyGesture messageId={id} onReply={() => mark(id)}>{child}</ReplyGesture>
    </section>
  );
  return (
    <main>
      <output data-testid="reply-log" />
      {item("text", <div id="text-target">Plain text message</div>)}
      {item("visual", <div id="visual-target" role="button" tabIndex={0}>Photo tile</div>)}
      {item("album-owned", <div id="album-owned-target" data-hscroll="album" data-hscroll-pass="0">Album interior</div>)}
      {item("album-edge", <div id="album-edge-target" data-hscroll="album" data-hscroll-pass="1">Album edge</div>)}
      {item("voice", <div data-testid="media-voice"><button id="voice-target" type="button">Play voice</button></div>)}
      {item("control", <button id="control-target" type="button">Open media</button>)}
      {item("back", <div id="back-target">iOS back-swipe gutter</div>)}
      {item("vertical", <div id="vertical-target">Vertical scroll</div>)}
      {item("threshold", <div id="threshold-target">Short drag</div>)}
      {item("mouse", <div id="mouse-target" style={{ padding: "14px 14px 14px 48px" }}>Mouse drag</div>)}
      {item("mouse-cancel", <div id="mouse-cancel-target" style={{ padding: "14px 14px 14px 48px" }}>Drag past then back</div>)}
      {item("click-guard", <div id="click-guard-target" role="button" tabIndex={0} style={{ padding: "14px 14px 14px 48px" }} onClick={() => mark("click")}>Tile with a tap action</div>)}
      {item("wheel", <div id="wheel-target" style={{ padding: 14 }}>Trackpad swipe</div>)}
      {item("wheel-vert", <div id="wheel-vert-target" style={{ padding: 14 }}>Trackpad scroll</div>)}
      {item("link", <div id="link-host" style={{ padding: "14px 14px 14px 48px" }}>See <a id="link-target" href="#linked" onClick={(e) => { e.preventDefault(); mark("link-click"); }}>this link</a> ok</div>)}
      {item("reaction", <div style={{ padding: "14px 14px 14px 48px" }}>Reacted <button id="reaction-target" type="button" onClick={() => mark("reaction-click")}>👍 2</button></div>)}
      {item("own", <div id="own-target" style={{ padding: "14px 14px 14px 48px", marginLeft: "auto", width: 200, textAlign: "right" }}>My own message</div>)}
      {item("select", <div id="select-target" style={{ padding: 4, fontSize: 20 }}>Select this sentence with the mouse please</div>)}
      <div id="spacer" style={{ height: 1400 }} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
