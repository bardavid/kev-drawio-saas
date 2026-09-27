# draw.ai

draw.ai is chat beside a live [diagrams.net](https://www.diagrams.net/) editor. Describe a change. The app writes draw.io / mxGraph XML and loads it into the canvas.

The site opens into the tool at `/`. `/app` redirects there.

**Kev** ([jaredpalmer/kev](https://github.com/jaredpalmer/kev)) is Jared Palmer’s open-source decision model. It is compatible with TypeSafe’s **Jev** and serves the same System One API (`POST /v1/systemone`) with typed answers: Choice, Noul, and Score. One call cannot plan a multi-shape diagram. A chain is applied edit by edit. A known diagram is a typed template: Jev confirms the node outline, then the edges, then the style, and the host writes the mxfile. With neither `KEV_BASE_URL` nor `OPENAI_API_KEY`, demo mode draws those same templates locally.

The canvas opens on a blank page. A draw replaces that page instead of patching a leftover sample. Topics such as Redis are sketched from a short Wikipedia summary when the network is available, and from a built-in brief when it is not. No API key is sent for that lookup.

## Local setup

```bash
npm install
cp .env.example .env.local   # optional
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm test
npm run build
```

The editor iframe loads `https://embed.diagrams.net`. That host has to be reachable from the browser.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | no | Fallback classifier and mxfile writer when Kev is not configured or is unreachable. Not required for multi-node Kev turns. |
| `OPENAI_BASE_URL` | no | Defaults to `https://api.openai.com/v1`. Any compatible `/chat/completions` base URL works. |
| `OPENAI_MODEL` | no | Defaults to `gpt-4o-mini`. |
| `KEV_BASE_URL` | no | Kev System One host. Requests go to `{KEV_BASE_URL}/v1/systemone`. |
| `KEV_API_KEY` | no | Sent as `Authorization: Bearer` only when set. Local `kev.serve` does not need it. |
| `KEV_MODEL` | no | Defaults to `kev-latest`. |

Copy `.env.example` to `.env.local`. Do not commit real keys. `.env*` is gitignored except `.env.example`.

### Pipeline

1. **Kev classify**, when `KEV_BASE_URL` is set. The first `POST /v1/systemone` asks for a single intent:

```json
{
  "state": "<user message + current diagram summary>",
  "model": "kev-latest",
  "questions": {
    "intent": {
      "type": "choice",
      "instructions": "What diagram edit does the user want?",
      "criteria": {
        "add_shape": "Add a new vertex/shape",
        "edit_shape": "Change an existing shape’s label or style",
        "delete_shape": "Remove a shape",
        "connect": "Add an edge between shapes",
        "layout": "Rearrange positions",
        "style": "Restyle without changing topology",
        "clarify": "Need more info from the user",
        "noop": "No diagram change"
      }
    },
    "needs_xml_edit": { "type": "noul", "instructions": "Should the diagram XML be modified?" }
  }
}
```

The real request also asks Choice questions for shape, color, layout, placement, and the shapes already on the canvas, plus a Score for how much of the diagram should change. A Noul at or above 0.5 means “yes.” `clarify` and `noop` never change the XML by themselves. Kev answers look like `{ "type": "choice", "choice", "probabilities", "confidence" }`, `{ "type": "noul", "noul" }`, and `{ "type": "score", "score", "legend", "probabilities", "confidence" }`.

2. **Diagram loop**, still on Kev, with no OpenAI key required. System One has no chain-of-thought and no open string slots, so one response cannot emit a multi-node plan. `src/lib/kev/orchestrate.ts` handles that:

   - A bare “draw” gets a second call (is the request specific?) and a clarifying question, not “No diagram change.”
   - A draw/build/create request that names a chain, a tier count, or several nodes is planned locally into ordered edits (add the missing shapes, connect them, then color and reflow when those words are in the request). “3 tier” with only the endpoints named inserts an App tier between them.
   - Each edit is its own `POST /v1/systemone`. The state is the user message plus the diagram *after earlier edits this turn*. Questions are `next` (apply / clarify / noop), `confirm` (noul), and closed choices for shape, color, or layout. Explicit color and direction words in the user message win. An unspecified chain, including “3 tier”, stays a horizontal row. Jev’s layout choice does not turn it into a column. “Vertically” still stacks it. Jev’s shape and color answers still fill those slots when the user did not name them.
   - For an explicit architecture plan, the planner applies every concrete step. A mid-range confirm (live Jev returned 0.43 on “add App”) and a `next` choice other than apply, including noop, do not cancel the drawing. The loop re-summarizes after each edit and stops when the plan is done, the file stops changing, or six steps have run. Single-edit gates are unchanged: those still need `next: apply` and a confirm noul of at least 0.5.
   - Typed templates cover the frequent asks: microservices, CQRS, event-driven (and Kafka), cache-aside, CDN, load balancer, checkout, OAuth, API call, approval / business process, ER / data model, AWS VPC (ALB → ECS → RDS), Kubernetes, state machine, DMZ / firewall, and system or API architecture, plus the existing login sequence, tax workflow, io_uring layers, and Redis cache. Each template is three System One calls — outline (`next` + `confirm`), structure (`next` + `confirm`), style (`next` + `confirm` + color). The host places every shape. A lukewarm confirm does not cancel the plan. A named color in the user message wins; otherwise the drawing stays the wireframe palette.
   - An unknown “draw a … diagram usage/architecture” prompt is researched first (Wikipedia, then a built-in brief). The brief becomes a small layered diagram — cache, queue, or client/topic/store — and runs through the same three gates. Redis keeps its own template.
   - If the rendered mxfile already matches the canvas, the turn is a noop. The reply does not claim an edit.
   - A single add, connect, rename, delete, reflow, or restyle that the first reading already describes is applied immediately (one call). If that reading is `noop` but the sentence is still a concrete edit, one gate call can still apply it.

   Named colors are resolved to palette `fillColor` and `strokeColor` before the response is returned. The optional `steps` array lists each gate. Jev is not asked to emit mxfile XML.

3. **XML writer**, when `OPENAI_API_KEY` is set and the turn is a single edit Kev already accepted. A chat-completions call receives that intent and returns an `mxfile`. Architecture turns skip this and use the loop above, so a Kev-only deployment can draw them.

4. **Language-model fallback.** If Kev is not configured, the model classifies the intent and writes the XML in one structured JSON response. If Kev is unreachable (network, timeout, or 401/403/404/408/429/5xx) and an OpenAI key is set, that path runs and the turn is marked `fallback: true`.

5. **Demo**, when neither `KEV_BASE_URL` nor `OPENAI_API_KEY` is set. The same templates and architecture planner run locally, and a deterministic parser handles single edits (add, connect, restyle, rename, delete, reflow). No network call. Unknown topics are not invented offline.

The server prefers a model’s `updatedXml` when it parses, keeps root cells `0` and `1`, and does not drop shapes the operations did not delete. Otherwise it applies the operations and sets `repaired: true`.

`npm test` mocks `POST /v1/systemone`. It does not call TypeSafe and does not need `KEV_BASE_URL`, `KEV_API_KEY`, or `OPENAI_API_KEY`. Each orchestrator call uses a 10s timeout so a six-step turn stays inside the route’s 60s limit.

## Draw.io embed and the XML loop

The editor embeds exactly:

`https://embed.diagrams.net/?embed=1&proto=json&configure=1&libraries=1&ui=min`

Messages are JSON strings (`proto=json`). The host only accepts events whose `source` is the iframe and whose origin is `embed.diagrams.net` (or another `*.diagrams.net` host).

1. **configure** — the iframe sends `{ "event": "configure" }` and waits. The host replies `{ "action": "configure", "config": { ... } }` with default vertex and orthogonal edge styles.
2. **init** — the iframe sends `{ "event": "init" }`. The editor is ready for data.
3. **load** — the host sends `{ "action": "load", "xml": "<mxfile>…</mxfile>", "autosave": 1, "fit": 1, "dark": 0 }`. XML may be an mxfile, a bare `mxGraphModel`, or a compressed diagram page. The iframe answers with `{ "event": "load", ...bounds }`.
4. **autosave / save** — the canvas is editable. Edits send `{ "event": "autosave", "xml": "…" }`. The Save button sends `{ "event": "save", "xml": "…" }`. The host stores that XML immediately and answers save with `{ "action": "status", "message": "Saved in this session", "modified": false }`.
5. **export** — the host sends `{ "action": "export", "format": "xml", "uncompressed": true, "compressed": false }` right before each chat send, after autosave (so a compressed autosave is replaced with uncompressed XML), when the tab hides, when focus returns from the iframe, and about every eight seconds while the editor is idle. `{ "event": "export", "xml" }` updates the React state the next message reads.
6. **apply** — when Kev returns a new mxfile, the host posts `{ "action": "load", "xml" }`, waits for `{ "event": "load" }`, exports once more, and stores that confirmed XML. Editing is suppressed only for that load-and-confirm. While chat is idle the canvas stays editable.
7. **spinner** — while a turn runs, the host sends `{ "action": "spinner", "show": true, "message": "…" }`, then hides it.

`POST /api/chat` accepts `{ messages, currentXml, previousXml? }`. `previousXml` is the last mxfile from before the user’s hand edits, when it differs. The server adds a short cell diff (added, removed, and changed ids and values) to the Kev state and to the XML-writer prompt, along with both mxfiles, so a request like “apply that same pattern somewhere else” can see what changed. The HTTP response is `{ reply, updatedXml, intent, slots, repaired, fallback?, confidence?, steps?, mode? }`. `steps` is present when the diagram loop ran. The payload omits `model`. It also omits `mode` when System One classified the turn, so the product does not advertise that host. `mode` is `demo` or `openai` on the other paths. `GET /api/chat` returns that same public status (`{ mode: "demo" }`, `{ mode: "openai" }`, or `{}`) and does not call a model. Internally the turn is still `demo`, `kev`, or `openai`, and the model id stays on the server.

If the editor reports a load error, the client toasts and keeps the previous XML.

Compressed pages (base64 of raw deflate of a URI-encoded `mxGraphModel`, the diagrams.net format) are inflated on the server before an edit and written back uncompressed.

### What the prompts teach

`src/lib/kev/prompt.ts` documents `mxfile`, `diagram`, `mxGraphModel`, `root`, `mxCell`, `mxGeometry`, vertex and edge flags, `parent`, `source` / `target`, and the usual style tokens (`rounded`, `whiteSpace=wrap`, `html=1`, `fillColor`, `strokeColor`, `shape=*`, orthogonal edges). The writer prompt is told the intent is already decided. The fallback prompt classifies it. Both prompts tell the model that a diagram diff is the user’s hand edit, and to repeat that pattern when asked. Intents are `add_shape`, `edit_shape`, `delete_shape`, `connect`, `layout`, `style`, `clarify`, and `noop`.

## Project layout

```
src/app/page.tsx            product (chat + diagram)
src/app/api/chat/route.ts   chat turn
src/components/editor       chat panel and diagrams.net frame
public/logo.svg             draw.ai mark
src/lib/drawio              embed protocol, starter XML, mxfile codec
src/lib/kev                 System One client, diagram loop, demo planner, mutator
```

`/app` redirects to `/`.

## Vercel

```bash
npx vercel --prod
```

In the Vercel project settings, add these variables. Leave them empty for demo mode. Do not commit real keys.

| Name | Placeholder |
| --- | --- |
| `OPENAI_API_KEY` | empty |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `KEV_BASE_URL` | empty |
| `KEV_API_KEY` | empty |

`KEV_MODEL` can stay unset; it defaults to `kev-latest`. Demo mode is what you get when `OPENAI_API_KEY` and `KEV_BASE_URL` are both empty.

This is a standard Next.js app. `npm run build` and `npm start` are enough. No `vercel.json` is required. The chat route runs on the Node.js runtime (`zlib` inflates diagram pages) and is `force-dynamic`, so the mode follows the runtime env rather than a value frozen at build. `maxDuration` is 60 seconds; hobby plans may cap function time lower, which only matters for slow model calls. Demo mode returns immediately.

The browser must be allowed to frame `https://embed.diagrams.net`. Diagram XML is included in chat requests so the model can edit it. Do not send diagrams you cannot share with the configured hosts.

## License

MIT. See [LICENSE](LICENSE).
