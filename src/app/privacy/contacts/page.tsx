import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Contacts & privacy — Open Lounge" };
export const dynamic = "force-static";

/** Renders docs/privacy-contacts.md (user-facing part, above the implementation notes). */
export default function PrivacyContacts() {
  let md = "";
  try {
    md = fs.readFileSync(path.join(process.cwd(), "docs", "privacy-contacts.md"), "utf8").split("\n---\n")[0];
  } catch {
    md = "# Contacts\nSee openlounge.app for our privacy policy.";
  }
  const blocks = md.split(/\n{2,}/).filter((b) => !b.startsWith("*Draft"));
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/).map((p, i) => (p.startsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p.replace(/"/g, "“")}</span>));
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-sm leading-relaxed text-zinc-300">
      {blocks.map((b, i) => {
        if (b.startsWith("# ")) return <h1 key={i} className="mb-4 text-2xl font-bold text-zinc-100">{b.slice(2)}</h1>;
        if (b.startsWith("## ")) return <h2 key={i} className="mt-6 mb-2 text-base font-semibold text-zinc-100">{b.slice(3)}</h2>;
        if (/^(- |\d\. )/.test(b))
          return (
            <ul key={i} className="mb-3 list-disc space-y-1 pl-5">
              {b.split(/\n(?=- |\d\. )/).map((li, j) => (
                <li key={j}>{inline(li.replace(/^(- |\d\. )/, "").replace(/\n\s+/g, " "))}</li>
              ))}
            </ul>
          );
        const [first, ...rest] = b.split(/\n(?=\d\. )/);
        return (
          <div key={i} className="mb-3">
            <p>{inline(first.replace(/\n/g, " "))}</p>
            {rest.length > 0 && (
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                {rest.map((li, j) => (
                  <li key={j}>{inline(li.replace(/^\d\. /, "").replace(/\n\s*/g, " "))}</li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </main>
  );
}
