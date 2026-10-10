import { Fragment } from "react";
import { parseMessageText } from "@/lib/chatFormatting";

/** Safe, shared display for chat text: supported emphasis is rendered as React nodes, never as HTML. */
export function MessageText({ text }: { text: string }) {
  const lines = parseMessageText(text);
  return (
    <>
      {lines.map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && <br />}
          {line.bullet && <span aria-hidden="true" className="select-none">• </span>}
          {line.tokens.map((token, tokenIndex) => {
            const key = `${lineIndex}-${tokenIndex}`;
            switch (token.kind) {
              case "bold":
                return <strong key={key} className="font-semibold">{token.value}</strong>;
              case "italic":
                return <em key={key}>{token.value}</em>;
              case "strike":
                return <s key={key}>{token.value}</s>;
              case "code":
                return <code key={key} className="rounded bg-black/10 px-1 font-mono text-[0.92em]">{token.value}</code>;
              default:
                return <Fragment key={key}>{token.value}</Fragment>;
            }
          })}
        </Fragment>
      ))}
    </>
  );
}
