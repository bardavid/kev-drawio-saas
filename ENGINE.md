# draw.ai engine

Locked product behavior for the chat and the canvas. Future changes should follow this file.

Provider and model names (`kev-latest`, `jev-latest`, and similar) stay off the end-user UI. Server configuration may still record them.

## Workflow

1. **Edit the open canvas.** A turn changes the diagram that is already open. It does not throw that diagram away and paste a fresh file. The trash control is a full reset: it clears the chat transcript and the canvas together, back to a blank page.

2. **A fresh chat starts blank.** The first screen has no starter shapes. Shapes appear after the first successful draw.

3. **Research only when the model is unsure.** External notes (a short Wikipedia summary, otherwise a built-in brief) are fetched only after a reading is unsure: the intent is `clarify` or `noop`, or the edit noul is below yes. Missing a template is not a reason to look anything up. A confident edit does not wait on the network. Known templates may still carry their own reference text without a lookup.

4. **Keep the three drawing steps for now.** A template or researched topic is still confirmed as outline, then edges, then style. Revisit that sequence later. Do not replace it in passing.

5. **Soft-fail when the XML does not change.** If a turn finishes on the same mxfile it started from, the chat says what happened and how to try again. The reply is not only “No diagram change.” A clarifying question (for example a bare “draw”) is not a soft-fail.

6. **Layout follows the diagram type.** Architecture chains and workflows run left to right. Sequences and stacked layers run top to bottom. Words in the request (“vertically”, “left to right”, and the same family) override that default. A restyle does not count as a layout request.

7. **Templates are a reference.** The model receives the template text and chooses whether to use it, adapt it, or set it aside. An explicit apply uses the template even when the confirm noul is lukewarm. An explicit noop or clarify does not paste the template. Demo mode has no model, so the host still draws a matching template onto a blank page. A chain the user actually named (Client → App → Postgres) is the user’s diagram, not a template, and is edited onto the open file.

8. **The chat stays quiet while a turn runs.** The transcript does not narrate steps. The diagram shows a spinner and nothing else speaks for the work.

9. **Quality comes before a latency budget.** Do not abort a turn early to hit a short time limit. Transport timeouts exist so a dead socket cannot hang the process. They are not a product deadline.

10. **Restyle keeps geometry.** Color and stroke changes do not move shapes, reroute edges, or delete cells. Positions change only when the user asks to rearrange.

11. **Undo rewinds from a user message.** Only a user message can be undone. Undoing it drops that message and everything after it (later user messages and assistant replies) and restores the diagram XML from the snapshot taken before that message. Browser back follows the same history. Assistant messages are not separate undo points.

12. **One draw at a time.** While a request is in flight the diagram does not accept edits, and another draw cannot be sent, until that request finishes.

## Already true in the host

- The embedded editor opens on an empty mxfile (`STARTER_XML` is blank).
- Style operations do not run the layout polish that moves untagged cells.
- Sequence messages are stacked top to bottom. Architecture inserts grow to the right unless the user asked for a column.
