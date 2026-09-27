import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const INTENTS = [
  ["add_shape", "Create a vertex, with a kind, a label, and an optional neighbor."],
  ["edit_shape", "Rename a box or change its shape without touching the rest."],
  ["delete_shape", "Remove a vertex and the edges that were holding onto it."],
  ["connect", "Draw an edge from one existing shape to another."],
  ["layout", "Reflow the page into a row or a column."],
  ["style", "Change fill and stroke using a named color."],
  ["clarify", "Ask one question when the sentence does not name a shape."],
  ["noop", "Leave the drawing alone."],
];

const LOOP = [
  ["01", "Listen", "The canvas stays editable. Autosave, save, and uncompressed export keep the host’s current XML in step with whatever you draw."],
  ["02", "Decide", "Kev answers POST /v1/systemone: a Choice for the intent and a Noul for whether the XML should change. The prompt includes the live mxfile and a diff of your hand edits."],
  ["03", "Write", "A second model call writes the full mxfile. The host loads it, exports once to confirm, and that confirmed XML is what the next message sees."],
];

export default function HomePage() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b bg-background">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6">
          <BrandMark />
          <nav className="flex items-center gap-1">
            <a href="#loop" className="hidden px-2 text-sm text-muted-foreground sm:inline">
              How it works
            </a>
            <Link href="/app" className={buttonVariants({ size: "sm" })}>
              Open workspace
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="border-b">
          <div className="mx-auto grid max-w-5xl items-start gap-16 px-6 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:py-28">
            <div className="flex flex-col gap-6">
              <p className="text-xs text-muted-foreground">System One for diagrams</p>
              <h1 className="max-w-xl text-4xl font-medium tracking-tight text-balance sm:text-5xl sm:leading-[1.1]">
                Say what should change. Kev edits the drawing.
              </h1>
              <p className="max-w-lg text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                <a className="text-foreground underline decoration-border underline-offset-4" href="https://github.com/jaredpalmer/kev">
                  Kev
                </a>{" "}
                is Jared Palmer’s open-source decision model, compatible with TypeSafe’s Jev. Both speak the System One
                API. Kev chooses a typed intent. A language model writes the draw.io XML, and the live canvas updates.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Link href="/app" className={cn(buttonVariants(), "h-9 px-3")}>
                  Open the workspace
                </Link>
                <a href="#loop" className={cn(buttonVariants({ variant: "outline" }), "h-9 px-3")}>
                  See the XML loop
                </a>
              </div>
            </div>

            <div className="border bg-card">
              <div className="flex h-8 items-center border-b px-3 text-xs text-muted-foreground">Workspace</div>
              <div className="grid md:grid-cols-[0.9fr_1.1fr]">
                <div className="flex flex-col gap-3 border-b p-4 md:border-r md:border-b-0">
                  <p className="text-xs leading-5 text-muted-foreground">Add a Redis cache in front of the database</p>
                  <p className="font-mono text-[11px] text-muted-foreground">add_shape</p>
                  <p className="text-sm leading-6">Added Redis in front of the database and rewired the edges through it.</p>
                </div>
                <svg viewBox="0 0 360 220" className="h-auto w-full bg-background" role="img" aria-label="Client connected to API, API connected to Redis">
                  <rect x="28" y="78" width="84" height="40" fill="none" stroke="#a3a3a3" />
                  <text x="70" y="103" textAnchor="middle" fontSize="12" fill="#171717" fontFamily="Inter, ui-sans-serif, system-ui, sans-serif">
                    Client
                  </text>
                  <rect x="148" y="78" width="72" height="40" fill="none" stroke="#a3a3a3" />
                  <text x="184" y="103" textAnchor="middle" fontSize="12" fill="#171717" fontFamily="Inter, ui-sans-serif, system-ui, sans-serif">
                    API
                  </text>
                  <rect x="256" y="70" width="76" height="56" rx="28" fill="none" stroke="#a3a3a3" />
                  <text x="294" y="103" textAnchor="middle" fontSize="12" fill="#171717" fontFamily="Inter, ui-sans-serif, system-ui, sans-serif">
                    Redis
                  </text>
                  <path d="M112 98 H148" stroke="#a3a3a3" strokeWidth="1" />
                  <path d="M220 98 H256" stroke="#a3a3a3" strokeWidth="1" />
                  <text x="28" y="186" fontSize="11" fill="#737373" fontFamily="ui-monospace, monospace">
                    place before · database
                  </text>
                </svg>
              </div>
            </div>
          </div>
        </section>

        <section id="loop" className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
          <h2 className="text-2xl font-medium tracking-tight">The loop</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            The editor is diagrams.net running in an iframe. The host and the iframe talk over{" "}
            <span className="font-mono text-xs text-foreground">postMessage</span>. Kev decides. A separate model call
            writes the mxfile.
          </p>
          <ol className="mt-10 grid gap-8 border-t pt-8 md:grid-cols-3 md:gap-10">
            {LOOP.map(([step, title, body]) => (
              <li key={step} className="border-b pb-6 md:border-b-0 md:pb-0">
                <p className="font-mono text-[11px] text-muted-foreground">{step}</p>
                <h3 className="mt-3 text-sm font-medium">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y">
          <div className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
            <h2 className="text-2xl font-medium tracking-tight">Typed decisions</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Jev is TypeSafe’s hosted decision model. Kev is the open-source server that speaks the same System One
              API. Each turn is one of eight intents. The workspace shows the choice before the shapes move.
            </p>
            <ul className="mt-8 border-t">
              {INTENTS.map(([intent, body]) => (
                <li key={intent} className="grid gap-1 border-b py-3 sm:grid-cols-[9rem_1fr] sm:gap-6 sm:py-3.5">
                  <span className="font-mono text-[11px] leading-6 text-muted-foreground">{intent}</span>
                  <span className="text-sm leading-6 text-foreground">{body}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto flex max-w-5xl flex-col items-start gap-4 px-6 py-20 sm:py-24">
          <h2 className="text-2xl font-medium tracking-tight">Start from a real architecture.</h2>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            The canvas opens on Client, API, and Postgres. With neither{" "}
            <span className="font-mono text-xs text-foreground">KEV_BASE_URL</span> nor{" "}
            <span className="font-mono text-xs text-foreground">OPENAI_API_KEY</span>, demo mode applies a few edits
            locally. Point Kev at Jared Palmer’s server for the typed decision, and set an OpenAI-compatible key so a
            model can write the mxfile.
          </p>
          <Link href="/app" className={cn(buttonVariants(), "h-9 px-3")}>
            Open the workspace
          </Link>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Kev Diagram · MIT</p>
          <p>
            Decisions by{" "}
            <a className="underline decoration-border underline-offset-4" href="https://github.com/jaredpalmer/kev">
              Kev
            </a>
            , not TypeSafe’s hosted Jev. Editor by diagrams.net.
          </p>
        </div>
      </footer>
    </div>
  );
}
