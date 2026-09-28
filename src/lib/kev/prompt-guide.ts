/**
 * Closed forks the decision model reads on every System One call.
 * The host still places geometry, gates research, and owns between-inserts.
 * Wording is generic: no prompt-specific templates.
 */

/** Compact block injected into every diagram state. */
export const STRATEGY_BLOCK = `STRATEGY
Syntax. The host states the diagram. You answer the questions. Do not invent coordinates, cell ids, or XML.
- Vertices: one line “- Label at (x, y)”. The point is the host’s placement. Do not choose an edit from it.
- Edges: one line “- From → To”, plus an optional “(label)”.
- Diagram diff: added, removed, and changed cells after a hand edit. Repeat that kind of change only when the user asks.
- Previous mxfile: a clip from before a hand edit. Current mxfile: a clip of the open canvas. Both are evidence. Do not write XML back.
- Topic context: notes the host already fetched. Use them. Do not ask for a lookup.
- Reference template: optional. If it fits → use it. If the user asked to change it → adapt it. If it does not fit → set it aside.

Practice. If the canvas already has shapes → edit those shapes. If the user did not name a shape to remove → keep it. Do not replace the file.
If you are confirming a composed diagram and the user named no color → leave color as none. The host then uses pastel fills, labeled edges, and topic containers. You do not invent those.
If a proper name sits beside a role word → the label is the proper name, and the role only picks the shape and the group. If only the role word is present → the label is the role.
If an insert says “box”, “shape”, “node”, “stage”, “between”, “in front of”, or “after” → those words are placement, not part of the new label. Strip them.
Midpoint and manner words (midstream, midway, halfway, and the same family) are placement too. Strip them wherever they sit in the new label.
If the edit is only color or stroke → it is a restyle. Geometry stays. Do not move, reroute, or delete cells.
Research runs only when a reading is unsure. The host already gates it.
Depth. Judge the idea before the boxes. A high-level idea, or boxes the user already named, is few. A low-level idea is detailed and needs many components and the interactions between them. Leftover noun fragments of the sentence are not those components. When the user did not name the components and the idea is detailed, that list is unsure until topic notes supply it.

Forks. Pick one branch. Do not blend them.
Intent: if the user only changes color or stroke of existing boxes or arrows → style. If they name a new node to add → add_shape. Never both.
needs_xml_edit: yes only if a concrete diagram change was requested. A bare “draw” with no subject → no.
Anchor: if the user said every or all boxes or arrows → none. If they named one shape → that shape. Never invent an anchor.
Color: if a color word is present → that color. Else → none.
Between-insert: if the user said X between A and B → the new node is X and the ends are A and B. Do not invent a Stage from placement fluff. The host splices that edge. A restyle is a small local edit, not a rebuild.`.trim();

export const STYLE_VS_ADD =
  "If the user only changes color or stroke of existing boxes or arrows → style. If they name a new node to add → add_shape. Never both.";

export const NEEDS_XML_FORK =
  "If a concrete diagram change was requested → yes. If the message is a bare draw with no subject → no. If it is only a greeting → no.";

export const ANCHOR_FORK =
  "If the user said every or all boxes or arrows → none. If they named one shape → that shape. Never invent an anchor.";

export const COLOR_FORK = "If a color word is present → that color. Else → none.";

export const BETWEEN_FORK =
  "If the user said X between A and B → the new node is X and the ends are A and B. Do not invent a Stage from placement fluff. The host splices that edge.";

/** Closed-set intent labels. Keys stay stable; the text is the fork. */
export const INTENT_CRITERIA = {
  add_shape: "If they name a new node to add → this, and not style.",
  edit_shape: "If they rename an existing shape or change its kind → this. A color-only change is style.",
  delete_shape: "If they name a shape to remove → this.",
  connect: "If they add an edge between existing shapes and name no new node → this.",
  layout: "If they only rearrange positions → this. A restyle is not a layout.",
  style:
    "If they only change color or stroke of existing boxes or arrows → this, and not add_shape. Arrows, edges, connectors, and lines are edges.",
  clarify: "If the message is a bare draw with no subject, or the subject is missing → this.",
  noop: "If nothing in the diagram should change → this.",
} as const;

export const INTENT_INSTRUCTIONS = `What diagram edit does the user want? ${STYLE_VS_ADD} If they only rename a label or change a shape kind → edit_shape. If they only remove a named shape → delete_shape. If they only add an edge and name no new node → connect. If they only rearrange → layout. If the message is a bare draw with no subject → clarify. If nothing should change → noop. Pick one. “change the boxes to red” → style. Recoloring arrows, edges, connectors, or lines → style.`;

export const NEEDS_XML_EDIT_INSTRUCTIONS = `Should the diagram XML be modified? ${NEEDS_XML_FORK}`;

export const SHAPE_INSTRUCTIONS =
  "Which shape kind should be used? If the user named a kind → that kind. Else → none.";

export const COLOR_INSTRUCTIONS = `Which named color should be applied? ${COLOR_FORK} “change the boxes to red” → red. “make the arrows blue” → blue.`;

export const LAYOUT_INSTRUCTIONS =
  "How should shapes be arranged? If the user asked for a column or top to bottom → vertical. If they asked for a row or left to right → horizontal. Else → none. A restyle is not a layout. The host places shapes when the answer is none.";

export const PLACE_INSTRUCTIONS = `Where should a new shape sit relative to an existing one? If they said in front of or before one named anchor → before. If they said behind or after one named anchor → after. ${BETWEEN_FORK} If they did not name a relative place → none.`;

export const ANCHOR_INSTRUCTIONS = `Which existing shape is the subject of this edit? ${ANCHOR_FORK} Arrows, edges, connectors, and lines are not a shape unless the user named an endpoint, such as arrows from Browser or arrows into Redis.`;

export const SOURCE_INSTRUCTIONS =
  "Which existing shape is the edge source? If the user named a source → that shape. Else → none. “Make the arrows blue” names no shape.";

export const TARGET_INSTRUCTIONS =
  "Which existing shape is the edge target? If the user named a destination → that shape. Else → none. “Make the arrows blue” names no shape.";

export const DISRUPTION_INSTRUCTIONS = `How much of the current diagram should change? If nothing was requested → leave the diagram alone. If only color, stroke, or a label changes → a small local edit. If a few edges are rewired → rewire a few shapes. If they asked to rebuild positions → rebuild the layout. ${BETWEEN_FORK} Do not score placement fluff as a rebuild.`;

export const DEPTH_INSTRUCTIONS = `Is this a high-level diagram or a low-level, detailed one? Judge the idea. If the user named the boxes, counted them, or drew a short chain → few. If the idea needs many components and the interactions between them → many. Leftover noun fragments of the sentence are not those components. “Two boxes: A and B” is few. A vague description of a rich system is many. Pick one.`;

export const DEPTH_CRITERIA = {
  few: "If a few boxes express the idea, or the user already named them → this.",
  many: "If the idea needs many components and interactions → this.",
} as const;

export const ANCHOR_NONE = "If they said every or all boxes or arrows, or named no single shape → this.";

export const SOURCE_NONE = "If the user named no source → this.";

export const TARGET_NONE = "If the user named no destination → this.";

export function namedShapeCriterion(label: string): string {
  return `If the user named ${label} → this.`;
}

export function shapeKindCriterion(kind: string): string {
  return `If the user asked for a ${kind} → this.`;
}

export const SHAPE_NONE = "If the user named no shape kind → this.";

export const SHAPE_KEEP = "If the user named no shape kind → this, and keep the proposal.";

export function colorCriterion(name: string): string {
  return `If the user named ${name} → this.`;
}

export const COLOR_NONE = "If no color word is present → this.";

export const COLOR_KEEP = "If no color word is present → this, and keep the proposed color.";

export const LAYOUT_CRITERIA = {
  horizontal: "If the user asked for a row or left to right → this.",
  vertical: "If the user asked for a column or top to bottom → this.",
  none: "If the user did not ask to rearrange → this. A restyle is not a layout.",
} as const;

export const PLACE_CRITERIA = {
  before: "If they said in front of or before one named anchor → this.",
  after: "If they said behind or after one named anchor → this.",
  none: "If they said between two shapes, or named no relative place → this. The host splices a between-insert.",
} as const;

export const SPECIFIC_INSTRUCTIONS =
  "Does the user name concrete shapes, connections, or a diagram to create? If they name a subject → yes. If the message is only a draw verb with no subject → no.";

export const SPECIFICITY_NEXT_INSTRUCTIONS =
  "The request does not name a diagram change. If a subject is missing → clarify. If the message is only a greeting → noop. Pick one.";

export const SPECIFICITY_NEXT_CRITERIA = {
  clarify: "If a subject is missing → this.",
  noop: "If the message is only a greeting → this.",
} as const;

export const STEP_NEXT_INSTRUCTIONS =
  "The host proposed one diagram edit. If that edit is the concrete change the user asked for → apply. If the proposal invents a node or a Stage from placement fluff → clarify. If the user asked for no change → noop. Pick one.";

export const STEP_CLARIFY = "If the proposal invents a node or a Stage from placement fluff → this.";

export const STEP_NOOP = "If the user asked for no change → this.";

export function stepApplyCriterion(detail: string): string {
  return `If this edit is the concrete change requested → this. ${detail}`;
}

export function stepConfirmInstructions(detail: string): string {
  return `Should this edit be written into the diagram XML now? If it is the concrete change requested → yes. If it invents a node, moves cells on a restyle, or adds a Stage from placement fluff → no. ${detail}`;
}

export const STEP_SHAPE_INSTRUCTIONS =
  "Which shape kind should the new vertex use? If the user named a kind → that kind. Else → none, and keep the proposal.";

export const STEP_COLOR_INSTRUCTIONS = `Which named color should be applied? ${COLOR_FORK} If the answer is none, keep the proposed color.`;

export const STEP_LAYOUT_INSTRUCTIONS =
  "How should the shapes be arranged? If the user asked for a column → vertical. If they asked for a row → horizontal. Else → none, and keep the proposed direction.";

export const STEP_LAYOUT_CRITERIA = {
  horizontal: "If the user asked for a row → this.",
  vertical: "If the user asked for a column → this.",
  none: "If the user did not name a direction → this, and keep the proposal.",
} as const;

export const COMPOSITION_COLOR_INSTRUCTIONS = `Which named color did the user ask for? ${COLOR_FORK}`;

export const COMPOSITION_REFERENCE_LEAD =
  "Reference template. If it fits the request → use it. If the user asked for a change → adapt it. If it does not fit → set it aside. The host places geometry. You do not.";

export type GuidePhase = "outline" | "structure" | "style";

export function compositionNextInstructions(phase: GuidePhase): string {
  if (phase === "outline") {
    return "The host proposed the nodes for this diagram. If the user named these nodes, or the idea is high-level and these few boxes express it → apply. If the idea is detailed and these nodes are leftover fragments of the sentence, or a few-box ask gained a node the user did not name → clarify. If the user asked not to draw → noop. Pick one.";
  }
  if (phase === "structure") {
    return "The host proposed the edges for this diagram. If these edges connect the named nodes → apply. If an edge was invented → clarify. If the user asked not to draw → noop. Pick one.";
  }
  return "The host will draw this planned diagram and lay it out. If the plan matches the request → apply. If it invents nodes or a Stage from placement fluff → clarify. If the user asked not to draw → noop. Pick one. The host places geometry.";
}

export function compositionConfirmInstructions(phase: GuidePhase): string {
  if (phase === "outline") {
    return "Are these the right nodes for the depth of the idea? If the user named them, or a few boxes express a high-level idea → yes. If a detailed idea collapsed into leftover fragments, or a few-box ask gained extra nodes → no.";
  }
  if (phase === "structure") {
    return "Are these the right edges? If they connect the named nodes → yes. If an edge was invented → no.";
  }
  return "Should this planned diagram be written into the diagram XML now? If it matches the request → yes. If it invents nodes or moves cells the user did not ask to move → no.";
}

export function compositionApplyCriterion(phase: GuidePhase): string {
  if (phase === "outline") return "If these nodes match the depth of the idea → this.";
  if (phase === "structure") return "If these edges connect the named nodes → this.";
  return "If the plan matches the request → this.";
}

export function compositionClarifyCriterion(phase: GuidePhase): string {
  if (phase === "outline") {
    return "If a detailed idea collapsed into leftover fragments, or a few-box ask gained a node the user did not name → this.";
  }
  if (phase === "structure") return "If an edge was invented → this.";
  return "If a node or edge was invented → this.";
}

export const COMPOSITION_CLARIFY = "If a node or edge was invented → this.";

export const COMPOSITION_NOOP = "If the user asked not to draw → this.";
