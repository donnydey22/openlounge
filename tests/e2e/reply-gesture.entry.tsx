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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
