# Kev Diagram

Kev Diagram is a small SaaS workspace for architecture drawings. Chat on the left, a live [diagrams.net](https://www.diagrams.net/) editor on the right. You describe a change in plain language. The app turns that sentence into draw.io / mxGraph XML and loads it into the canvas.

**Kev** ([jaredpalmer/kev](https://github.com/jaredpalmer/kev)) is Jared Palmer’s open-source decision model. It is compatible with TypeSafe’s **Jev** and serves the same System One API (`POST /v1/systemone`) with typed answers: Choice, Noul, and Score. Jev is TypeSafe’s hosted model. Kev is the open-source server you can run yourself. This app asks Kev for the intent, then asks a separate language model to write the mxfile.

The first screen is a starter architecture — Client, API, Postgres — so the canvas is never blank.

## Local setup

```bash
npm install
cp .env.example .env.local   # optional
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the marketing page and [http://localhost:3000/app](http://localhost:3000/app) for the workspace.

```bash
npm test
npm run build
```

The editor iframe loads `https://embed.diagrams.net`. That host has to be reachable from the browser.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | no | Language model that writes the mxfile. Also the fallback classifier when Kev is unreachable. |
| `OPENAI_BASE_URL` | no | Defaults to `https://api.openai.com/v1`. Any compatible `/chat/completions` base URL works. |
| `OPENAI_MODEL` | no | Defaults to `gpt-4o-mini`. |
| `KEV_BASE_URL` | no | Kev System One host. Requests go to `{KEV_BASE_URL}/v1/systemone`. |
| `KEV_API_KEY` | no | Sent as `Authorization: Bearer` only when set. Local `kev.serve` does not need it. |
| `KEV_MODEL` | no | Defaults to `kev-latest`. |

Copy `.env.example` to `.env.local`. Do not commit real keys. `.env*` is gitignored except `.env.example`.

### Pipeline

1. **Kev**, when `KEV_BASE_URL` is set. `POST /v1/systemone` with:

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

The real request also asks Choice questions for shape, color, layout, placement, and the shapes already on the canvas, plus a Score for how much of the diagram should change. A Noul at or above 0.5 means “edit.” `clarify` and `noop` never change the XML. Kev answers look like `{ "type": "choice", "choice", "probabilities", "confidence" }`, `{ "type": "noul", "noul" }`, and `{ "type": "score", "score", "legend", "probabilities", "confidence" }`.

2. **XML writer**, when `OPENAI_API_KEY` is set and Kev said to edit. A second chat-completions call receives Kev’s intent, slots, confidence, and score, plus a system prompt that documents mxGraph XML. It returns the full updated `mxfile`.

3. **Language-model fallback.** If Kev is not configured, the same model classifies the intent and writes the XML in one structured JSON response. If Kev is configured but unreachable (network, timeout, or 401/403/404/408/429/5xx) and an OpenAI key is set, that same JSON path runs and the turn is marked `fallback: true`. A Kev-only deployment (no OpenAI key) applies Kev’s choices with a small deterministic parser for free-text labels such as “Redis”.

4. **Demo**, when neither `KEV_BASE_URL` nor `OPENAI_API_KEY` is set. A deterministic parser handles a handful of sentences (add, connect, restyle, rename, delete, reflow) and the XML mutator writes the file. No network call.

The server prefers the model’s `updatedXml` when it parses, keeps root cells `0` and `1`, and does not drop shapes the operations did not delete. Otherwise it applies the operations and sets `repaired: true`.

## Draw.io embed and the XML loop

The workspace embeds exactly:

`https://embed.diagrams.net/?embed=1&proto=json&configure=1&libraries=1&ui=min`

Messages are JSON strings (`proto=json`). The host only accepts events whose `source` is the iframe and whose origin is `embed.diagrams.net` (or another `*.diagrams.net` host).

1. **configure** — the iframe sends `{ "event": "configure" }` and waits. The host replies `{ "action": "configure", "config": { ... } }` with default vertex and orthogonal edge styles.
2. **init** — the iframe sends `{ "event": "init" }`. The editor is ready for data.
3. **load** — the host sends `{ "action": "load", "xml": "<mxfile>…</mxfile>", "autosave": 1, "fit": 1, "dark": 0 }`. XML may be an mxfile, a bare `mxGraphModel`, or a compressed diagram page. The iframe answers with `{ "event": "load", ...bounds }`.
4. **autosave / save** — the canvas is editable. Edits send `{ "event": "autosave", "xml": "…" }`. The Save button sends `{ "event": "save", "xml": "…" }`. The host stores that XML immediately and answers save with `{ "action": "status", "message": "Saved in this session", "modified": false }`.
5. **export** — the host sends `{ "action": "export", "format": "xml", "uncompressed": true, "compressed": false }` right before each chat send, after autosave (so a compressed autosave is replaced with uncompressed XML), when the tab hides, when focus returns from the iframe, and about every eight seconds while the editor is idle. `{ "event": "export", "xml" }` updates the React state the next message reads.
6. **apply** — when Kev returns a new mxfile, the host posts `{ "action": "load", "xml" }`, waits for `{ "event": "load" }`, exports once more, and stores that confirmed XML. Editing is suppressed only for that load-and-confirm. While chat is idle the canvas stays editable.
7. **spinner** — while a turn runs, the host sends `{ "action": "spinner", "show": true, "message": "…" }`, then hides it.

`POST /api/chat` accepts `{ messages, currentXml, previousXml? }`. `previousXml` is the last mxfile from before the user’s hand edits, when it differs. The server adds a short cell diff (added, removed, and changed ids and values) to the Kev state and to the XML-writer prompt, along with both mxfiles, so a request like “apply that same pattern somewhere else” can see what changed. The response is `{ reply, updatedXml, intent, slots, mode, model, repaired, fallback?, confidence? }`. `mode` is `demo`, `kev`, or `openai`. `GET /api/chat` returns the configured pipeline and does not call Kev or a model.

If the editor reports a load error, the client toasts and keeps the previous XML.

Compressed pages (base64 of raw deflate of a URI-encoded `mxGraphModel`, the diagrams.net format) are inflated on the server before an edit and written back uncompressed.

### What the prompts teach

`src/lib/kev/prompt.ts` documents `mxfile`, `diagram`, `mxGraphModel`, `root`, `mxCell`, `mxGeometry`, vertex and edge flags, `parent`, `source` / `target`, and the usual style tokens (`rounded`, `whiteSpace=wrap`, `html=1`, `fillColor`, `strokeColor`, `shape=*`, orthogonal edges). The writer prompt is told the intent is already decided. The fallback prompt classifies it. Both prompts tell the model that a diagram diff is the user’s hand edit, and to repeat that pattern when asked. Intents are `add_shape`, `edit_shape`, `delete_shape`, `connect`, `layout`, `style`, `clarify`, and `noop`.

## Project layout

```
src/app/page.tsx            marketing site
src/app/app/page.tsx        /app workspace
src/app/api/chat/route.ts   chat turn
src/components/workspace    chat panel and diagrams.net frame
src/lib/drawio              embed protocol, starter XML, mxfile codec
src/lib/kev                 System One client, XML writer, demo parser, mutator
```

## GitHub

Target repository: [github.com/bardavid/kev-drawio-saas](https://github.com/bardavid/kev-drawio-saas).

This environment could not create it. `gh` is not logged in, and the connected GitHub token returned `403 Resource not accessible by personal access token` for both a private and a public `POST /user/repos`. After a token that can create repositories is available:

```bash
gh auth login
gh repo create bardavid/kev-drawio-saas --private --source=. --remote=github --push
```

If the empty repository already exists:

```bash
git remote add github https://github.com/bardavid/kev-drawio-saas.git
git push -u github main
```

## Vercel

The Vercel CLI is not installed here and no Vercel account is logged in, so production was not deployed. From a machine that is logged in:

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
