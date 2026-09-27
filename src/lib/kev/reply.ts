/** Chat copy when a turn ends on the same mxfile it started from. */
export const UNCHANGED_DIAGRAM_REPLY =
  "The canvas is unchanged. Name the shapes and the edit you want, then try again — for example “Client → App → Postgres”.";

/** Chat copy when a full template would replace shapes that are already on the page. */
export const KEPT_CANVAS_REPLY =
  "The canvas already has a diagram, so I left it in place. Clear it to draw this fresh, or name the shapes to add or change.";

const BLUNT_UNCHANGED = /^no diagram change\.?$/i;

/** Replace a blunt unchanged-XML reply. Leave clarifying questions and real explanations alone. */
export function softenUnchangedReply(reply: string, xmlUnchanged: boolean): string {
  if (!xmlUnchanged) return reply;
  const trimmed = reply.trim();
  if (!trimmed || BLUNT_UNCHANGED.test(trimmed)) return UNCHANGED_DIAGRAM_REPLY;
  return reply;
}
