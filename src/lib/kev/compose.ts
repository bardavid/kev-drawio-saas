import { PALETTE, SHAPE_STYLE, applyColors, inferShape, type ShapeKind } from "@/lib/drawio/styles";
import {
  absoluteGeometry,
  cellLabel,
  diagramIsBlank,
  firstChildTag,
  getRoot,
  listEdges,
  listVertices,
  nextCellId,
  normalizeMxfile,
  numberAttr,
  openDiagram,
  serializeDiagram,
} from "@/lib/drawio/xml";
import {
  chainEdgeLabel,
  chainRole,
  composeNamedDiagram,
  extractNamedEntities,
  labeledPlacement,
  listedComponents,
  isMessageExchange,
  listedProcessSteps,
  rolePaint,
  topicLabelFor,
} from "@/lib/kev/entities";
import {
  architectureDecision,
  isBetweenEdit,
  isRenameEdit,
  layoutDefault,
  opensPicture,
  operationsForPlan,
  parseArchitecture,
  requestedLayout,
  resolvePlan,
  withPalette,
  type PlanHints,
} from "@/lib/kev/plan";
import { builtinBrief, redisDiagramRequest } from "@/lib/kev/research";
import { routeEdges } from "@/lib/drawio/layout";
import { architectureFromIdea } from "@/lib/kev/invent";
import {
  componentsFromBrief,
  depthFromOpenAnswer,
  highLevelOverview,
  ideaSubject,
  isExpandFollowUp,
  longUnlistedDescription,
  overviewSubject,
  pluralRoleOf,
  type BriefLink,
} from "@/lib/kev/scale";
import { composeFromBrief, matchTemplate } from "@/lib/kev/templates";
import type { KevDecision } from "@/lib/kev/types";

type XmlElement = import("@xmldom/xmldom").Element;
type XmlDocument = import("@xmldom/xmldom").Document;

const WIRE_FILL = "#ffffff";
const WIRE_STROKE = "#334155";
const WIRE_FONT = "#0f172a";
const CLUSTER_HEADER = "#f1f5f9";
const CLUSTER_BODY = "#ffffff";
const CLUSTER_STROKE = "#cbd5e1";

const COLUMN = 230;
const LANE = 68;

export type CompositionKind = "sequence" | "workflow" | "layers";

interface PalettePaint {
  fill: string;
  stroke: string;
  font: string;
}

export interface SequenceParticipant {
  id: string;
  label: string;
  shape: ShapeKind;
  fill?: string;
  stroke?: string;
}

export interface SequenceMessage {
  from: string;
  to: string;
  label: string;
  dashed?: boolean;
}

export interface SequenceSpec {
  kind: "sequence";
  title: string;
  reply: string;
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
}

export interface FlowNode {
  id: string;
  label: string;
  shape: ShapeKind;
  column: number;
  row: number;
  fill?: string;
  stroke?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  /** Leave the source from this side. Defaults to a straight neighbor link. */
  exit?: "top" | "bottom" | "right" | "left";
}

export interface WorkflowSpec {
  kind: "workflow";
  title: string;
  reply: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface LayerNode {
  id: string;
  label: string;
  shape: ShapeKind;
  fill?: string;
  stroke?: string;
}

export interface LayerGroup {
  id: string;
  label: string;
  nodes: LayerNode[];
  /** `row` places children side by side. The default stacks them. */
  flow?: "row" | "column";
}

export interface LayerEdge {
  from: string;
  to: string;
  label: string;
  /** Draw beside the stack so a return arrow does not sit on the forward arrow. */
  side?: boolean;
}

export interface LayerEnclosure {
  id: string;
  label: string;
  /** Group ids wrapped by the outer frame. Groups left out stay outside it. */
  groups: string[];
}

export interface LayerSpec {
  kind: "layers";
  title: string;
  reply: string;
  groups: LayerGroup[];
  edges: LayerEdge[];
  enclosure?: LayerEnclosure;
  /**
   * `horizontal` places topic groups left to right.
   * Omitted groups stay stacked top to bottom.
   */
  axis?: "horizontal" | "vertical";
}

export type CompositionSpec = SequenceSpec | WorkflowSpec | LayerSpec;

export interface Composition {
  spec: CompositionSpec;
  colorName: string | null;
  /** Factual notes included in the planner prompt. */
  context: string | null;
  /** Wikipedia title to refresh `context` from. Null skips the network. */
  researchQuery: string | null;
  /** Type default, unless the user named a direction. */
  layout: "horizontal" | "vertical";
  /**
   * The user already named at least two services, steps, actors, or states.
   * Outline confirm must not ask for those names again.
   */
  grounded?: boolean;
}

interface Placed {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: string;
  /** Index into the placed list of the container. Unset for the page layer. */
  parentIndex?: number;
}

interface DrawnEdge {
  from: string;
  to: string;
  label: string;
  style: string;
  points: Array<{ x: number; y: number }>;
}

const COLOR_RE = new RegExp(`\\b(${Object.keys(PALETTE).join("|")})\\b`, "i");

export function colorInMessage(message: string): string | null {
  return message.match(COLOR_RE)?.[1]?.toLowerCase() ?? null;
}

/** True when both strings are the same mxfile after normalization. */
export function sameMxfile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return normalizeMxfile(a) === normalizeMxfile(b);
  } catch {
    return false;
  }
}

function wantsPicture(text: string): boolean {
  return /\b(draw|sketch|diagram|show|illustrate|map)\b/i.test(text);
}

function isIoUring(text: string): boolean {
  return /\bio[\s_-]?uring\b/i.test(text) && (/\bxfs\b/i.test(text) || /\bfilesystem\b/i.test(text));
}

function isLoginSequence(text: string): boolean {
  return /\bsequence\b/i.test(text) && /\b(login|log[\s-]?in|sign[\s-]?in|signin|auth(?:entication)?)\b/i.test(text);
}

function isSequence(text: string): boolean {
  return /\bsequence(\s+diagram)?\b/i.test(text);
}

function isTaxWorkflow(text: string): boolean {
  return /\b(workflow|flowchart|process)\b/i.test(text) && /\b(tax|irs|1040|filing)\b/i.test(text);
}

function isWorkflow(text: string): boolean {
  return /\b(workflow|flowchart)\b/i.test(text);
}

const PASTEL_NAMES = ["orange", "green", "blue", "purple", "yellow", "teal", "pink"] as const;

function isSingleInsert(text: string): boolean {
  if (/\bbetween\b/i.test(text) || /\bconnect(?:ed|s)?\b/i.test(text)) return true;
  const relation = text.match(/\b(?:in front of|ahead of|before|behind|after)\b/i);
  if (!relation || relation.index === undefined) return false;
  const tail = text.slice(relation.index + relation[0].length);
  return extractNamedEntities(tail).length < 2;
}

function isIncrementalEdit(text: string): boolean {
  const trimmed = text.trim();
  // "Splice Test between Build and Deploy stages" edits the open edge. It is not a new chain.
  if (isBetweenEdit(trimmed)) return true;
  if (isRenameEdit(trimmed)) return true;
  if (/^(?:please\s+)?(?:rename|relabel|delete|remove|connect)\b/i.test(trimmed)) return true;
  if (/^(?:please\s+)?(?:add|insert|place|put|drop)\b/i.test(trimmed)) {
    // "Put Client, API, and Postgres" names a new diagram. "Add X in front of Y" edits one.
    if (isSingleInsert(trimmed)) return true;
    return extractNamedEntities(trimmed).length < 2;
  }
  if (/^(?:please\s+)?(?:paint|recolor|recolour|restyle)\b/i.test(trimmed)) return true;
  if (/^(?:please\s+)?(?:change|make|turn|set|style|color|colour)\b/i.test(trimmed) && COLOR_RE.test(trimmed)) {
    return true;
  }
  if (/^(?:please\s+)?(?:lay|reflow|relayout|re-layout|arrange|organize|organise)\b/i.test(trimmed)) {
    // "Lay out three boxes labeled A, B, and C" places those boxes.
    // "Lay out a system that … — show the moving parts" is a new picture.
    // Neither one is a reflow of the open canvas.
    return !labeledPlacement(trimmed) && !opensPicture(trimmed);
  }
  return false;
}

function specLabels(spec: CompositionSpec): string[] {
  if (spec.kind === "sequence") return spec.participants.map((participant) => participant.label);
  if (spec.kind === "workflow") return spec.nodes.map((node) => node.label);
  return [
    ...spec.groups.flatMap((group) => [group.label, ...group.nodes.map((node) => node.label)]),
    ...(spec.enclosure ? [spec.enclosure.label] : []),
  ];
}

const ROLE_GLOSS = new Set([
  "browser",
  "browsers",
  "client",
  "clients",
  "frontend",
  "backend",
  "server",
  "servers",
  "service",
  "services",
  "app",
  "application",
  "web",
  "tier",
  "tiers",
  "layer",
  "layers",
]);

function labelCovered(have: Set<string>, label: string): boolean {
  const key = label.toLowerCase();
  if (have.has(key)) return true;
  // "Pods" is already on a diagram that drew "Pod A" and "Pod B".
  if (key.endsWith("s")) {
    const stem = key.slice(0, -1);
    if (stem.length >= 3) {
      for (const item of have) {
        if (item === stem || item.startsWith(`${stem} `)) return true;
      }
    }
  }
  // "Database" is already drawn as "Primary database". "API" is not "API Gateway".
  if (key.length >= 5) {
    for (const item of have) {
      if (item.endsWith(` ${key}`)) return true;
    }
  }
  // "Browser Clients" is the client tier a template already draws as "Browser".
  const words = key.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const hit = words.some((word) => have.has(word) || (word.endsWith("s") && have.has(word.slice(0, -1))));
    const gloss = words.filter((word) => !have.has(word) && !(word.endsWith("s") && have.has(word.slice(0, -1))));
    if (hit && gloss.every((word) => ROLE_GLOSS.has(word))) return true;
  }
  return false;
}

/** Every named label already appears on the spec. Extra template nodes are fine. */
export function specCovers(spec: CompositionSpec, labels: string[]): boolean {
  const have = new Set(specLabels(spec).map((label) => label.toLowerCase()));
  return labels.every((label) => labelCovered(have, label));
}

/** The generic bus sketch. A vendor stack keeps its own services. */
const BUS_ALIAS = /^(?:pub\/sub|pubsub|kafka|message bus|event bus|event broker|queue|queues|sns|sqs)$/i;

function catalogLabels(text: string): string[] {
  return extractNamedEntities(text)
    .filter((entity) => entity.origin === "catalog")
    .map((entity) => entity.label);
}

/**
 * Event-broker presets invent Web, Billing, and Mail.
 * They only stand in when the user did not name a peer service beside the bus.
 */
function looseDropsPeers(spec: CompositionSpec, labels: string[]): boolean {
  if (spec.title !== "Event-driven" && spec.title !== "Kafka") return false;
  const have = new Set(specLabels(spec).map((label) => label.toLowerCase()));
  return labels.some((label) => !labelCovered(have, label) && !BUS_ALIAS.test(label));
}

/**
 * One matching clause (CI/CD, cache-aside, a CDN) must not swallow a prompt
 * that also names the rest of a stack. Extra template nodes are fine.
 * Dropping most of the named services is not.
 */
/** A process list the template does not draw. Two named steps are enough. */
function listedStepsUncovered(spec: CompositionSpec, text: string): boolean {
  const steps = listedProcessSteps(text);
  if (!steps || steps.length < 2) return false;
  return !specCovers(spec, steps);
}

function templateDropsNamedWork(spec: CompositionSpec, labels: string[]): boolean {
  // Two named products the sketch does not draw are enough. A three-name stack
  // used to pass the five-label cutoff and was replaced by the sketch.
  if (labels.length < 2) return false;
  const have = new Set(specLabels(spec).map((label) => label.toLowerCase()));
  const uncovered = labels.filter((label) => !labelCovered(have, label));
  if (uncovered.length < 2) return false;
  return uncovered.length * 2 >= labels.length;
}

function architectureOwns(text: string, labels: string[]): boolean {
  const plan = parseArchitecture(text);
  if (!plan || plan.nodes.length < 2) return false;
  if (labels.length < 2) return true;
  const nodes = new Set(plan.nodes.map((node) => node.toLowerCase()));
  return labels.every((label) => nodes.has(label.toLowerCase()));
}

function chainCovers(node: string, label: string): boolean {
  const planNode = node.toLowerCase();
  const named = label.toLowerCase();
  return planNode === named || named.includes(planNode) || planNode.includes(named);
}

/**
 * Named composition kept the app and the database and dropped another tier
 * the architecture chain already named. That chain draws every tier.
 * A richer list (extra products the chain cannot spell) stays on named composition.
 */
function namedDropsChain(text: string, labels: string[]): boolean {
  const plan = parseArchitecture(text);
  if (!plan || plan.nodes.length < 2 || labels.length < 2) return false;
  const missing = plan.nodes.filter((node) => !labels.some((label) => chainCovers(node, label)));
  if (missing.length === 0) return false;
  const extra = labels.filter((label) => !plan.nodes.some((node) => chainCovers(node, label)));
  return extra.length === 0;
}

function tintSpec(spec: CompositionSpec): CompositionSpec {
  const colorAt = (index: number) => PALETTE[PASTEL_NAMES[index % PASTEL_NAMES.length]!]!;
  if (spec.kind === "sequence") {
    return {
      ...spec,
      participants: spec.participants.map((participant, index) => {
        const color = colorAt(index);
        return participant.fill ? participant : { ...participant, fill: color.fill, stroke: color.stroke };
      }),
    };
  }
  if (spec.kind === "workflow") {
    return {
      ...spec,
      nodes: spec.nodes.map((node, index) => {
        const color = colorAt(index);
        return node.fill ? node : { ...node, fill: color.fill, stroke: color.stroke };
      }),
    };
  }
  let index = 0;
  return {
    ...spec,
    groups: spec.groups.map((group) => ({
      ...group,
      nodes: group.nodes.map((node) => {
        const color = colorAt(index);
        index += 1;
        return node.fill ? node : { ...node, fill: color.fill, stroke: color.stroke };
      }),
    })),
  };
}

function packComposition(
  spec: CompositionSpec,
  text: string,
  hints: { colorName?: string | null; context?: string | null } | undefined,
  context: string | null,
  grounded: boolean,
): Composition {
  const painted = grounded && !wantsPicture(text) && !colorInMessage(text) ? tintSpec(spec) : spec;
  const named = colorInMessage(text);
  const brief = builtinBrief(text);
  return {
    spec: painted,
    colorName: named ?? hints?.colorName ?? null,
    context: hints?.context ?? brief?.summary ?? context,
    researchQuery: brief?.topic ?? null,
    layout: requestedLayout(text) ?? layoutDefault(painted.kind),
    grounded,
  };
}

function compositionFromNamed(text: string): Composition | null {
  const named = composeNamedDiagram(text);
  if (!named) return null;
  const listed = named.participants.map((node) => node.label).join(", ");
  if (named.kind === "sequence") {
    return packComposition(
      {
        kind: "sequence",
        title: named.title,
        reply: named.reply,
        participants: named.participants.map((node) => ({
          id: node.id,
          label: node.label,
          shape: node.shape,
          fill: node.fill,
          stroke: node.stroke,
        })),
        messages: named.messages,
      },
      text,
      undefined,
      `The user named ${listed}. Draw each one.`,
      true,
    );
  }
  return packComposition(
    {
      kind: "layers",
      title: named.title,
      reply: named.reply,
      groups: named.groups.map((group) => ({
        id: group.id,
        label: group.label,
        flow: group.flow,
        nodes: group.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          shape: node.shape,
          fill: node.fill,
          stroke: node.stroke,
        })),
      })),
      edges: named.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        side: edge.side,
      })),
    },
    text,
    undefined,
    `The user named ${listed}. Draw each one.`,
    true,
  );
}

/**
 * A blank-canvas architecture chain: one topic group per named tier, pastel fills,
 * and a label on every edge. A named color still replaces the pastel. A process
 * list of four or more steps is not an architecture chain.
 */
export function blankArchitectureVisual(message: string, hints?: PlanHints): Composition | null {
  const steps = listedProcessSteps(message);
  if (steps && steps.length >= 4) return null;
  const plan = parseArchitecture(message, hints);
  if (!plan || plan.nodes.length < 2) return null;
  const perRole = new Map<ReturnType<typeof chainRole>, number>();
  const nodes = plan.nodes.map((label, index) => {
    const role = chainRole(label);
    const nth = perRole.get(role) ?? 0;
    perRole.set(role, nth + 1);
    const paint = rolePaint(role, nth);
    return {
      id: `tier-${index + 1}`,
      label,
      shape: inferShape(label),
      fill: paint.fill,
      stroke: paint.stroke,
      group: topicLabelFor(role),
    };
  });
  const horizontal = plan.layout !== "vertical";
  const spec: LayerSpec = {
    kind: "layers",
    title: plan.title ?? "Architecture",
    reply: plan.nodes.join(" → "),
    axis: horizontal ? "horizontal" : "vertical",
    groups: nodes.map((node) => ({
      id: `group-${node.id}`,
      label: node.group,
      flow: "column" as const,
      nodes: [{ id: node.id, label: node.label, shape: node.shape, fill: node.fill, stroke: node.stroke }],
    })),
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index]?.id ?? node.id,
      to: node.id,
      label: chainEdgeLabel(nodes[index]?.label ?? node.label, node.label),
    })),
  };
  return {
    spec,
    colorName: plan.colorName,
    context: null,
    researchQuery: null,
    layout: horizontal ? "horizontal" : "vertical",
    grounded: true,
  };
}

/**
 * Blank-canvas architecture uses the visual bar. A page that already has shapes
 * keeps the edit planner.
 */
export function renderBlankArchitecture(
  message: string,
  xml: string,
  hints?: PlanHints,
): { decision: KevDecision; xml: string } | null {
  if (!diagramIsBlank(xml)) return null;
  const visual = blankArchitectureVisual(message, hints);
  const plan = resolvePlan(message, hints);
  if (!visual || !plan) return null;
  const operations = operationsForPlan(plan, xml);
  if (operations.length === 0) return null;
  return { decision: architectureDecision(plan, operations), xml: renderComposition(visual) };
}

/**
 * Sequence, workflow, and layered diagrams the chain planner cannot express.
 * A prompt that already names two or more services, steps, actors, or states
 * composes even when it never says "draw".
 */
export function resolveComposition(
  message: string,
  hints?: { colorName?: string | null; context?: string | null },
): Composition | null {
  const text = message.trim();
  if (!text || isIncrementalEdit(text)) return null;
  const labels = extractNamedEntities(text).map((entity) => entity.label);
  const grounded = labels.length >= 2;
  const picture = wantsPicture(text);
  if (!picture && !grounded) return null;

  if (isIoUring(text)) return packComposition(ioUringSpec(), text, hints, null, false);

  const matched = matchTemplate(text);
  // A typed template already knows its own stack. A single phrase match must
  // not discard the other services the user named.
  const dropsNamed =
    matched != null &&
    grounded &&
    (looseDropsPeers(matched.spec, labels) ||
      templateDropsNamedWork(matched.spec, labels) ||
      listedStepsUncovered(matched.spec, text));
  if (matched && !dropsNamed) {
    return packComposition(matched.spec, text, hints, matched.context, grounded);
  }

  if (isLoginSequence(text)) {
    const spec = loginSequence(text);
    if (!grounded || specCovers(spec, catalogLabels(text))) return packComposition(spec, text, hints, null, grounded);
  }

  if (redisDiagramRequest(text)) {
    const spec = redisUsageSpec();
    // Catalog-only coverage is vacuous when every named product is ad hoc.
    // The usage sketch applies only when it already draws those names.
    if (!grounded || specCovers(spec, labels)) {
      return packComposition(spec, text, hints, builtinBrief(text)?.summary ?? null, grounded);
    }
  }

  const flowchart = flowchartSpec(text);
  if (flowchart) return packComposition(flowchart, text, hints, null, true);

  // A hop, message-flow, or choreography is a sequence of the named actors.
  // The architecture chain must not swallow the participant who starts it.
  if (architectureOwns(text, labels) && !labeledPlacement(text) && !isMessageExchange(text)) return null;

  // Scraps of a longer description are not the named boxes. Sequences and
  // workflows below still draw. A template already returned above.
  // "Walk through …" never says draw, but it is still an unnamed idea.
  if (!longUnlistedDescription(text) && grounded && (isMessageExchange(text) || !namedDropsChain(text, labels))) {
    const composed = compositionFromNamed(text);
    if (composed) {
      if (hints?.colorName && !composed.colorName) composed.colorName = hints.colorName;
      if (hints?.context) composed.context = hints.context;
      return composed;
    }
  }

  if (matched || !picture) return null;
  if (isTaxWorkflow(text)) return packComposition(taxWorkflow(), text, hints, null, false);
  if (isSequence(text)) return packComposition(genericSequence(text), text, hints, null, false);
  if (isWorkflow(text)) return packComposition(genericWorkflow(text), text, hints, null, false);
  return null;
}

/**
 * The user described an idea and did not name the boxes. Known sketches already
 * returned from resolveComposition. What remains is not a two-fragment drawing.
 */
export function unresolvedOpenIdea(message: string): boolean {
  const text = message.trim();
  if (!longUnlistedDescription(text)) return false;
  if (listedComponents(text) || highLevelOverview(text)) return false;
  // A depth answer names no new system. Without a prior question it is not drawn.
  if (depthFromOpenAnswer(text)) return false;
  return resolveComposition(text) === null && parseArchitecture(text) === null;
}

/**
 * Drawings the host can place without asking which shape to use.
 * A short overview is one subject box. A labeled set, or components named in
 * the message, is one vertex each. Topic notes are not required for either.
 */
export function hostPreparedComposition(message: string): Composition | null {
  if (labeledPlacement(message) || listedComponents(message)) {
    const composed = resolveComposition(message);
    return composed?.grounded ? composed : null;
  }
  if (!highLevelOverview(message) || resolveComposition(message)) return null;
  return highLevelComposition(message);
}

/** One box for a high-level reading. The subject stays whole. */
export function highLevelComposition(message: string): Composition | null {
  const label = overviewSubject(message) ?? ideaSubject(message);
  if (!label) return null;
  const paint = PALETTE.orange!;
  const spec: LayerSpec = {
    kind: "layers",
    title: label,
    reply: `Drew a high-level view of ${label}.`,
    groups: [
      {
        id: "idea",
        label,
        nodes: [{ id: "idea-1", label, shape: "rectangle", fill: paint.fill, stroke: paint.stroke }],
      },
    ],
    edges: [],
  };
  return {
    spec,
    colorName: null,
    context: null,
    researchQuery: null,
    layout: requestedLayout(message) ?? layoutDefault(spec.kind),
    grounded: false,
  };
}

/**
 * A detailed reading whose components come from topic notes.
 * Returns null when the notes do not name enough interacting parts.
 */
export function composeDetailedFromBrief(message: string, summary: string): Composition | null {
  const parts = componentsFromBrief(summary);
  if (!parts) return null;
  return compositionFromParts(message, parts, summary);
}

/**
 * The user already chose a detailed diagram and asked for the names.
 * Topic notes did not supply them, so the host invents the roles of the system.
 * Clause scraps of the sentence are not those boxes.
 */
export function composeDetailedFromIdea(message: string): Composition | null {
  const invented = architectureFromIdea(message);
  if (!invented) return null;
  return compositionFromInvented(message, invented);
}

function compositionFromInvented(
  message: string,
  invented: NonNullable<ReturnType<typeof architectureFromIdea>>,
): Composition {
  const layout = requestedLayout(message) ?? "horizontal";
  const perRole = new Map<string, number>();
  const placed = invented.nodes.map((node, index) => {
    const nth = perRole.get(node.role) ?? 0;
    perRole.set(node.role, nth + 1);
    const paint = rolePaint(node.role, nth);
    return { ...node, id: `role-${index + 1}`, paint };
  });
  const idByLabel = new Map(placed.map((node) => [node.label.toLowerCase(), node.id]));
  const spec: LayerSpec = {
    kind: "layers",
    title: invented.title,
    reply: `Drew ${invented.nodes.map((node) => node.label).join(", ")}.`,
    axis: layout === "vertical" ? "vertical" : "horizontal",
    groups: placed.map((node) => ({
      id: `band-${node.id}`,
      label: node.group,
      nodes: [{ id: node.id, label: node.label, shape: node.shape, fill: node.paint.fill, stroke: node.paint.stroke }],
    })),
    edges: invented.edges.map((edge) => ({
      from: idByLabel.get(edge.from.toLowerCase()) ?? edge.from,
      to: idByLabel.get(edge.to.toLowerCase()) ?? edge.to,
      label: edge.label,
    })),
  };
  return {
    spec,
    colorName: null,
    context: null,
    researchQuery: ideaSubject(message),
    layout: layout === "vertical" ? "vertical" : "horizontal",
    grounded: false,
  };
}

function compositionFromParts(
  message: string,
  parts: { nodes: string[]; edges: BriefLink[] },
  context: string | null,
): Composition {
  const layout = requestedLayout(message) ?? layoutDefault("layers");
  const ids = new Map<string, string>();
  parts.nodes.forEach((label, index) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";
    ids.set(label.toLowerCase(), `${base}-${index + 1}`);
  });
  const indexOf = new Map(parts.nodes.map((label, index) => [label.toLowerCase(), index]));
  const spec: LayerSpec = {
    kind: "layers",
    title: ideaSubject(message) ?? "Diagram",
    reply: `Drew ${parts.nodes.join(", ")}.`,
    axis: layout === "horizontal" ? "horizontal" : undefined,
    groups: parts.nodes.map((label, index) => {
      const paint = PALETTE[PASTEL_NAMES[index % PASTEL_NAMES.length]!]!;
      const id = ids.get(label.toLowerCase()) ?? `part-${index + 1}`;
      return {
        id: `band-${id}`,
        label,
        nodes: [{ id, label, shape: "rectangle" as const, fill: paint.fill, stroke: paint.stroke }],
      };
    }),
    edges: parts.edges.map((edge) => {
      const from = ids.get(edge.from.toLowerCase()) ?? edge.from;
      const to = ids.get(edge.to.toLowerCase()) ?? edge.to;
      const fromAt = indexOf.get(edge.from.toLowerCase()) ?? 0;
      const toAt = indexOf.get(edge.to.toLowerCase()) ?? 0;
      return {
        from,
        to,
        label: edge.label,
        side: layout !== "horizontal" && Math.abs(fromAt - toAt) > 1,
      };
    }),
  };
  return {
    spec,
    colorName: null,
    context,
    researchQuery: ideaSubject(message),
    layout,
    grounded: false,
  };
}

export function describeComposition(composition: Composition): string {
  const lines = plannedSteps(composition.spec);
  const direction = composition.layout === "vertical" ? "top to bottom" : "left to right";
  const steps = [
    `Diagram: ${composition.spec.kind}`,
    `Layout: ${direction}`,
    "Steps:",
    ...lines.map((line, index) => `${index + 1}. ${line}`),
  ];
  if (!composition.context) return steps.join("\n");
  return [`Topic context:\n${composition.context}`, "", ...steps].join("\n");
}

/** Reference text for a template or a named architecture. The model may use, adapt, or ignore it. */
export function templateReferenceFor(message: string, topicContext?: string | null): string | null {
  const composition =
    resolveComposition(message, topicContext ? { context: topicContext } : undefined) ??
    (topicContext ? composeFromBrief(message, topicContext) : null);
  if (composition) {
    return `Reference template. Use it, adapt it, or set it aside.\n${describeComposition(composition)}`;
  }
  const plan = resolvePlan(message);
  if (!plan) return null;
  const direction = plan.layout === "vertical" ? "top to bottom" : "left to right";
  return `Reference architecture (${direction}): ${plan.nodes.join(" → ")}. Edit the open canvas.`;
}

/** A template replaces the page only when the page is blank and the drawing is new. */
export function templateCanvasPlan(currentXml: string, rendered: string): "draw" | "unchanged" | "keep" {
  if (sameMxfile(rendered, currentXml)) return "unchanged";
  if (!diagramIsBlank(currentXml)) return "keep";
  return "draw";
}

/** Soft stop when a single drawing would have to hold more named services than we can lay out. */
export const MAX_NAMED_ENTITIES = 40;

export const CAPACITY_REPLY =
  "That names more services than fit on one diagram. Split it into two drawings, or name the part to draw first.";

export function overNamedCapacity(message: string): boolean {
  return extractNamedEntities(message).length > MAX_NAMED_ENTITIES;
}

/**
 * An ask that extends the open canvas. A fresh "draw …" on a page that already
 * has shapes is a different diagram and stays put.
 */
export function isAdditiveExtension(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isBetweenEdit(trimmed)) return false;
  if (/\b(?:instead|from scratch|start over|redraw|wipe|clear (?:it|the canvas|this|the diagram))\b/i.test(trimmed)) {
    return false;
  }
  // Scale complaints and plural roles grow the open canvas instead of starting over.
  if (isExpandFollowUp(trimmed) || pluralRoleOf(trimmed)) return true;
  if (/^(?:please\s+)?(?:also|additionally|furthermore)\b/i.test(trimmed)) return true;
  if (/\b(?:attach|extend|splice)\b/i.test(trimmed)) return true;
  if (/\b(?:add|include|put)\b/i.test(trimmed) && /\b(?:onto|on top of|as well|too|strip|alongside)\b/i.test(trimmed)) {
    return true;
  }
  return /\b(?:to|onto) (?:the|this|our) (?:diagram|canvas|stack|architecture|drawing)\b/i.test(trimmed);
}

function contentLabels(spec: CompositionSpec): string[] {
  if (spec.kind === "sequence") return spec.participants.map((participant) => participant.label);
  if (spec.kind === "workflow") return spec.nodes.map((node) => node.label);
  return spec.groups.flatMap((group) => group.nodes.map((node) => node.label));
}

export function additiveDecision(composition: Composition, xml: string): KevDecision {
  const labels = contentLabels(composition.spec);
  const listed = labels.join(", ");
  return {
    intent: "add_shape",
    reply: listed ? `Added ${listed} onto the diagram.` : "Added the new shapes onto the diagram.",
    slots: withPalette({
      label: composition.spec.title,
      shape: "rectangle",
      colorName: composition.colorName,
      layout: composition.layout,
    }),
    operations: [],
    updatedXml: xml,
  };
}

/** Place a new composition to the right of the open canvas. Labels already there are left alone. */
export function spliceDiagram(currentXml: string, rendered: string): string | null {
  const host = openDiagram(currentXml);
  const incoming = openDiagram(rendered);
  const hostRoot = getRoot(host);
  const existing = listVertices(host);
  const have = new Set(existing.map((cell) => cellLabel(cell).trim().toLowerCase()).filter(Boolean));

  let maxX = 0;
  let minY = 40;
  let seenY = false;
  for (const cell of existing) {
    const box = absoluteGeometry(cell);
    maxX = Math.max(maxX, box.x + box.width);
    if (!seenY || box.y < minY) minY = box.y;
    seenY = true;
  }

  const fresh = listVertices(incoming).filter((cell) => {
    const label = cellLabel(cell).trim().toLowerCase();
    return !label || !have.has(label);
  });
  if (fresh.length === 0) return null;

  let minX = Infinity;
  let incomingMinY = Infinity;
  for (const cell of fresh) {
    const box = absoluteGeometry(cell);
    minX = Math.min(minX, box.x);
    incomingMinY = Math.min(incomingMinY, box.y);
  }
  const dx = maxX + 80 - minX;
  const dy = minY - incomingMinY;

  const idMap = new Map<string, string>();
  let next = Number(nextCellId(host));
  if (!Number.isFinite(next)) next = 2;
  for (const cell of fresh) {
    const copy = host.importNode(cell, true) as XmlElement;
    const oldId = copy.getAttribute("id") ?? "";
    const id = String(next);
    next += 1;
    idMap.set(oldId, id);
    copy.setAttribute("id", id);
    const oldParent = cell.getAttribute("parent") ?? "1";
    const mappedParent = idMap.get(oldParent);
    const geometry = firstChildTag(copy, "mxGeometry");
    if (mappedParent) {
      copy.setAttribute("parent", mappedParent);
    } else if (geometry) {
      copy.setAttribute("parent", "1");
      const abs = absoluteGeometry(cell);
      geometry.setAttribute("x", String(Math.round(abs.x + dx)));
      geometry.setAttribute("y", String(Math.round(abs.y + dy)));
    } else {
      copy.setAttribute("parent", "1");
    }
    hostRoot.appendChild(copy);
  }

  for (const edge of listEdges(incoming)) {
    const source = idMap.get(edge.getAttribute("source") ?? "");
    const target = idMap.get(edge.getAttribute("target") ?? "");
    if (!source || !target) continue;
    const copy = host.importNode(edge, true) as XmlElement;
    copy.setAttribute("id", String(next));
    next += 1;
    copy.setAttribute("parent", "1");
    copy.setAttribute("source", source);
    copy.setAttribute("target", target);
    const points = copy.getElementsByTagName("mxPoint");
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (!point) continue;
      const x = numberAttr(point, "x", Number.NaN);
      const y = numberAttr(point, "y", Number.NaN);
      if (Number.isFinite(x)) point.setAttribute("x", String(Math.round(x + dx)));
      if (Number.isFinite(y)) point.setAttribute("y", String(Math.round(y + dy)));
    }
    hostRoot.appendChild(copy);
  }

  const model = host.getElementsByTagName("mxGraphModel")[0];
  if (model) {
    let pageW = numberAttr(model, "pageWidth", 1169);
    let pageH = numberAttr(model, "pageHeight", 827);
    for (const cell of listVertices(host)) {
      const box = absoluteGeometry(cell);
      pageW = Math.max(pageW, box.x + box.width + 80);
      pageH = Math.max(pageH, box.y + box.height + 80);
    }
    model.setAttribute("pageWidth", String(Math.ceil(pageW / 10) * 10));
    model.setAttribute("pageHeight", String(Math.ceil(pageH / 10) * 10));
  }
  return serializeDiagram(host);
}

const ADD_EDGE_STYLE =
  "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" +
  "endArrow=classic;endFill=1;strokeColor=#64748b;fontColor=#334155;fontSize=12;labelBackgroundColor=#ffffff;";

function contentVertexByLabel(doc: XmlDocument, label: string): XmlElement | null {
  const want = label.trim().toLowerCase();
  if (!want) return null;
  for (const cell of listVertices(doc)) {
    const style = cell.getAttribute("style") ?? "";
    if (/(?:^|;)drawai=(?:cluster|lifeline|anchor)(?:;|$)/.test(style)) continue;
    if (cellLabel(cell).trim().toLowerCase() === want) return cell;
  }
  return null;
}

/**
 * Labeled edges from shapes already on the canvas to shapes just spliced on.
 * Existing routed edges stay. New edges are routed around the open diagram.
 */
export function attachLabeledEdges(
  xml: string,
  links: Array<{ from: string; to: string; label: string }>,
): string {
  if (links.length === 0) return xml;
  const doc = openDiagram(xml);
  const root = getRoot(doc);
  let next = Number(nextCellId(doc));
  if (!Number.isFinite(next)) next = 2;
  let added = false;
  for (const link of links) {
    const source = contentVertexByLabel(doc, link.from);
    const target = contentVertexByLabel(doc, link.to);
    const sourceId = source?.getAttribute("id");
    const targetId = target?.getAttribute("id");
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const duplicate = listEdges(doc).some(
      (edge) => edge.getAttribute("source") === sourceId && edge.getAttribute("target") === targetId,
    );
    if (duplicate) continue;
    const cell = doc.createElement("mxCell");
    cell.setAttribute("id", String(next));
    next += 1;
    cell.setAttribute("value", link.label);
    cell.setAttribute("style", ADD_EDGE_STYLE);
    cell.setAttribute("edge", "1");
    cell.setAttribute("parent", "1");
    cell.setAttribute("source", sourceId);
    cell.setAttribute("target", targetId);
    const geometry = doc.createElement("mxGeometry");
    geometry.setAttribute("relative", "1");
    geometry.setAttribute("as", "geometry");
    cell.appendChild(geometry);
    root.appendChild(cell);
    added = true;
  }
  if (!added) return xml;
  routeEdges(doc);
  return serializeDiagram(doc);
}

export function composeOnCanvas(
  message: string,
  currentXml: string,
  composition: Composition,
  rendered: string,
): { xml: string; decision: KevDecision } | "keep" | "unchanged" {
  const canvas = templateCanvasPlan(currentXml, rendered);
  if (canvas === "unchanged") return "unchanged";
  if (canvas === "keep") {
    if (!isAdditiveExtension(message)) return "keep";
    const merged = spliceDiagram(currentXml, rendered);
    if (!merged || sameMxfile(merged, currentXml)) return "keep";
    return { xml: merged, decision: additiveDecision(composition, merged) };
  }
  return { xml: rendered, decision: compositionDecision(composition, rendered) };
}

export function compositionDecision(composition: Composition, xml: string): KevDecision {
  const layout = composition.layout;
  return {
    intent: "add_shape",
    reply: composition.spec.reply,
    slots: withPalette({
      label: composition.spec.title,
      shape: "rectangle",
      colorName: composition.colorName,
      layout,
    }),
    operations: [],
    updatedXml: xml,
  };
}

export function renderComposition(composition: Composition): string {
  const paint = paintFor(composition.colorName);
  const drawn = drawSpec(composition.spec, paint, Boolean(composition.colorName));
  padLeft(drawn.nodes, drawn.edges, 80);
  return xmlFor(drawn.nodes, drawn.edges, composition.spec.title);
}

function plannedSteps(spec: CompositionSpec): string[] {
  if (spec.kind === "sequence") {
    return [
      ...spec.participants.map((participant) => `Add lifeline ${participant.label}`),
      ...spec.messages.map((message) => `Message ${message.from} → ${message.to}: ${message.label}`),
      "Place participants in a row and stack messages top to bottom",
    ];
  }
  if (spec.kind === "workflow") {
    return [
      ...spec.nodes.map((node) => `Add stage ${node.label}`),
      ...spec.edges.map((edge) => `Connect ${edge.from} to ${edge.to}${edge.label ? ` (${edge.label})` : ""}`),
      "Lay stages left to right and route branches off the decision",
    ];
  }
  return [
    ...(spec.enclosure ? [`Open cluster ${spec.enclosure.label}`] : []),
    ...spec.groups.flatMap((group) => [`Open cluster ${group.label}`, ...group.nodes.map((node) => `Add ${node.label}`)]),
    ...spec.edges.map((edge) => `Connect ${edge.from} to ${edge.to}: ${edge.label}`),
    "Stack clusters vertically and route the return edge beside the stack",
  ];
}

function loginSequence(text: string): SequenceSpec {
  if (/\buser\s*db\b/i.test(text) || /\b(db lookup|session cookie)\b/i.test(text)) {
    return {
      kind: "sequence",
      title: "Login",
      reply: "Drew a login sequence: User, Browser, Auth Service, and User DB.",
      participants: [
        { id: "user", label: "User", shape: "actor" },
        { id: "browser", label: "Browser", shape: "rectangle" },
        { id: "auth", label: "Auth Service", shape: "rectangle" },
        { id: "db", label: "User DB", shape: "rectangle" },
      ],
      messages: [
        { from: "user", to: "browser", label: "Request credentials" },
        { from: "browser", to: "auth", label: "Validate" },
        { from: "auth", to: "db", label: "DB lookup" },
        { from: "db", to: "auth", label: "User record", dashed: true },
        { from: "auth", to: "browser", label: "Session cookie set", dashed: true },
      ],
    };
  }
  // "with … database" names a participant. The short login sketch used to drop it.
  if (/\b(database|databases|\bdb\b)\b/i.test(text)) {
    return {
      kind: "sequence",
      title: "User login",
      reply: "Drew a login sequence: User, Browser, Auth Service, and Database.",
      participants: [
        { id: "user", label: "User", shape: "actor" },
        { id: "browser", label: "Browser", shape: "rectangle" },
        { id: "auth", label: "Auth Service", shape: "rectangle" },
        { id: "db", label: "Database", shape: "rectangle" },
      ],
      messages: [
        { from: "user", to: "browser", label: "Enter credentials" },
        { from: "browser", to: "auth", label: "POST /login" },
        { from: "auth", to: "db", label: "Query" },
        { from: "db", to: "auth", label: "User record", dashed: true },
        { from: "auth", to: "browser", label: "Session", dashed: true },
        { from: "browser", to: "user", label: "Logged in", dashed: true },
      ],
    };
  }
  return {
    kind: "sequence",
    title: "User login",
    reply: "Drew a login sequence: User, Browser, and Auth Service.",
    participants: [
      { id: "user", label: "User", shape: "actor" },
      { id: "browser", label: "Browser", shape: "rectangle" },
      { id: "auth", label: "Auth Service", shape: "rectangle" },
    ],
    messages: [
      { from: "user", to: "browser", label: "Enter credentials" },
      { from: "browser", to: "auth", label: "POST /login" },
      { from: "auth", to: "browser", label: "Session", dashed: true },
      { from: "browser", to: "user", label: "Logged in", dashed: true },
    ],
  };
}

function genericSequence(message: string): SequenceSpec {
  const topic = message
    .replace(/^(?:please\s+)?(?:draw|sketch|diagram|show|illustrate|map)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "")
    .replace(/\bsequence(\s+diagram)?\b/i, "")
    .replace(/\bdiagram\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = topic || "request";
  return {
    kind: "sequence",
    title: name,
    reply: `Drew a sequence for ${name}.`,
    participants: [
      { id: "user", label: "User", shape: "actor" },
      { id: "service", label: "Service", shape: "rectangle" },
    ],
    messages: [
      { from: "user", to: "service", label: `Request ${name}`.trim() },
      { from: "service", to: "user", label: "Response", dashed: true },
    ],
  };
}

function taxWorkflow(): WorkflowSpec {
  return {
    kind: "workflow",
    title: "US tax filing",
    reply: "Drew the US tax filing workflow, from collecting documents through payment or refund.",
    nodes: [
      { id: "docs", label: "Collect documents", shape: "document", column: 0, row: 0 },
      { id: "form", label: "Complete Form 1040", shape: "document", column: 1, row: 0 },
      { id: "review", label: "Review return", shape: "rectangle", column: 2, row: 0 },
      { id: "file", label: "E-file", shape: "rectangle", column: 3, row: 0 },
      { id: "due", label: "Balance due?", shape: "diamond", column: 4, row: 0 },
      { id: "pay", label: "Pay the IRS", shape: "rectangle", column: 5, row: -1 },
      { id: "refund", label: "Receive refund", shape: "rectangle", column: 5, row: 1 },
    ],
    edges: [
      { from: "docs", to: "form" },
      { from: "form", to: "review" },
      { from: "review", to: "file" },
      { from: "file", to: "due" },
      { from: "due", to: "pay", label: "Yes", exit: "top" },
      { from: "due", to: "refund", label: "No", exit: "bottom" },
    ],
  };
}

function stepLabel(raw: string): string {
  return raw
    .replace(/^(?:and|then|of)\s+/i, "")
    .replace(/[?.!]+$/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

/** Ordered clauses in a flowchart become one node each. A title before the colon is not a step. */
function flowchartSpec(text: string): WorkflowSpec | null {
  if (!/\bflowchart\b/i.test(text)) return null;
  const colon = text.indexOf(":");
  const body = colon === -1 ? text.replace(/^.*?\bflowchart\b(?:\s+of)?/i, "") : text.slice(colon + 1);
  const steps = body
    .split(/\s*(?:,|;)\s*|\s+\bthen\b\s+/i)
    .map(stepLabel)
    .filter((step) => step.length > 1);
  if (steps.length < 2) return null;
  const heading = (colon === -1 ? "" : text.slice(0, colon)).replace(/\bflowchart\b/i, " ").replace(/\bof\b/i, " ");
  const title = stepLabel(heading) || "Flowchart";
  return {
    kind: "workflow",
    title,
    reply: `Drew a flowchart: ${steps.join(" → ")}.`,
    nodes: steps.map((label, index) => ({
      id: `step-${index + 1}`,
      label,
      shape: "rectangle" as const,
      column: index,
      row: 0,
    })),
    edges: steps.slice(1).map((_, index) => ({
      from: `step-${index + 1}`,
      to: `step-${index + 2}`,
      label: "Next",
    })),
  };
}

function genericWorkflow(message: string): WorkflowSpec {
  const topic = message
    .replace(/^(?:please\s+)?(?:draw|sketch|diagram|show|illustrate|map)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "")
    .replace(/\b(workflow|flowchart|diagram|process)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = topic || "Workflow";
  return {
    kind: "workflow",
    title: name,
    reply: `Drew a workflow for ${name}.`,
    nodes: [
      { id: "start", label: "Start", shape: "rectangle", column: 0, row: 0 },
      { id: "work", label: name, shape: "rectangle", column: 1, row: 0 },
      { id: "done", label: "Done", shape: "rectangle", column: 2, row: 0 },
    ],
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "done" },
    ],
  };
}

function redisUsageSpec(): LayerSpec {
  return {
    kind: "layers",
    title: "Redis cache usage",
    reply:
      "Drew Redis cache usage: Client → App → Redis cache, with replication, persistence, and a database read on miss.",
    groups: [
      { id: "clients", label: "Clients", nodes: [{ id: "client", label: "Client", shape: "rectangle" }] },
      { id: "application", label: "Application", nodes: [{ id: "app", label: "App", shape: "rectangle" }] },
      {
        id: "redis",
        label: "Redis",
        nodes: [
          { id: "cache", label: "Redis cache", shape: "cylinder" },
          { id: "replica", label: "Replica", shape: "cylinder" },
          { id: "persist", label: "Persistence", shape: "cylinder" },
        ],
      },
      { id: "data", label: "Data", nodes: [{ id: "db", label: "Database", shape: "cylinder" }] },
    ],
    edges: [
      { from: "client", to: "app", label: "Request" },
      { from: "app", to: "cache", label: "GET / SET" },
      { from: "cache", to: "replica", label: "Replicate" },
      { from: "cache", to: "persist", label: "Persist", side: true },
      { from: "app", to: "db", label: "Read on miss", side: true },
    ],
  };
}

function ioUringSpec(): LayerSpec {
  return {
    kind: "layers",
    title: "io_uring on XFS",
    reply: "Drew io_uring on XFS: the application submits SQEs, XFS serves the I/O, and completions return on the CQ.",
    groups: [
      { id: "user", label: "Userspace", nodes: [{ id: "app", label: "Application", shape: "rectangle" }] },
      {
        id: "kernel",
        label: "Kernel",
        nodes: [
          { id: "uring", label: "io_uring", shape: "rectangle" },
          { id: "xfs", label: "XFS", shape: "rectangle" },
        ],
      },
      { id: "storage", label: "Storage", nodes: [{ id: "block", label: "Block device", shape: "cylinder" }] },
    ],
    edges: [
      { from: "app", to: "uring", label: "Submit SQE" },
      { from: "uring", to: "app", label: "Complete CQE", side: true },
      { from: "uring", to: "xfs", label: "Read / write" },
      { from: "xfs", to: "block", label: "Block I/O" },
    ],
  };
}

function paintFor(colorName: string | null): PalettePaint {
  const named = colorName ? PALETTE[colorName] : undefined;
  if (!named) return { fill: WIRE_FILL, stroke: WIRE_STROKE, font: WIRE_FONT };
  return { fill: named.fill, stroke: named.stroke, font: named.font ?? WIRE_FONT };
}

function nodePaint(
  own: { fill?: string; stroke?: string },
  fallback: PalettePaint,
  force: boolean,
): PalettePaint {
  if (!force && own.fill && own.stroke) return { fill: own.fill, stroke: own.stroke, font: fallback.font };
  return fallback;
}

function nodeStyle(shape: ShapeKind, paint: PalettePaint, role: string): string {
  const base = applyColors(SHAPE_STYLE[shape], paint.fill, paint.stroke, paint.font);
  return `${base}fontSize=13;fontFamily=Helvetica;drawai=${role};`;
}

function sizeFor(shape: ShapeKind): { width: number; height: number } {
  if (shape === "actor") return { width: 48, height: 72 };
  if (shape === "diamond") return { width: 156, height: 92 };
  if (shape === "cylinder") return { width: 168, height: 80 };
  if (shape === "document") return { width: 176, height: 72 };
  if (shape === "cloud") return { width: 168, height: 96 };
  if (shape === "hexagon") return { width: 168, height: 80 };
  if (shape === "queue") return { width: 176, height: 72 };
  if (shape === "ellipse") return { width: 150, height: 72 };
  return { width: 176, height: 64 };
}

function drawSpec(spec: CompositionSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  if (spec.kind === "sequence") return drawSequence(spec, paint, force);
  if (spec.kind === "workflow") return drawWorkflow(spec, paint, force);
  return drawLayers(spec, paint, force);
}

function drawSequence(spec: SequenceSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  const header = 56;
  const longest = spec.participants.reduce((max, participant) => Math.max(max, participant.label.length), 0);
  const width = Math.max(150, Math.min(210, Math.round(28 + longest * 7.2)));
  const column = Math.max(COLUMN, width + 56);
  const height = header + 48 + spec.messages.length * LANE + 28;
  const nodes: Placed[] = spec.participants.map((participant, index) => {
    const ink = nodePaint(participant, paint, force);
    return {
      id: participant.id,
      label: participant.label,
      x: 80 + index * column,
      y: 40,
      width,
      height,
      style:
        `shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;collapsible=0;` +
        `recursiveResize=0;outlineConnect=0;portConstraint=eastwest;size=${header};` +
        `fillColor=${ink.fill};strokeColor=${ink.stroke};fontColor=${ink.font};` +
        `fontSize=13;fontFamily=Helvetica;drawai=node;`,
    };
  });

  const edges: DrawnEdge[] = spec.messages.map((message, index) => {
    const frac = (header + 40 + index * LANE) / height;
    const arrow = message.dashed ? "endArrow=open;endFill=0;dashed=1;" : "endArrow=classic;endFill=1;";
    return {
      from: message.from,
      to: message.to,
      label: message.label,
      points: [],
      style:
        `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;${arrow}` +
        `exitX=0.5;exitY=${frac.toFixed(3)};entryX=0.5;entryY=${frac.toFixed(3)};` +
        `strokeColor=${WIRE_STROKE};fontColor=${WIRE_FONT};fontSize=12;labelBackgroundColor=#ffffff;` +
        "drawai=message;drawai=routed;",
    };
  });
  return { nodes, edges };
}

function drawWorkflow(spec: WorkflowSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  const slot = 228;
  const mainY = 220;
  const nodes: Placed[] = spec.nodes.map((node) => {
    const size = sizeFor(node.shape);
    const x = 40 + node.column * slot + (slot - size.width) / 2;
    let y = mainY;
    if (node.row < 0) y = mainY - size.height - 72;
    if (node.row > 0) y = mainY + 92 + 72;
    return {
      id: node.id,
      label: node.label,
      x,
      y,
      width: size.width,
      height: size.height,
      style: nodeStyle(node.shape, nodePaint(node, paint, force), "node"),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: DrawnEdge[] = spec.edges.map((edge) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) {
      return { from: edge.from, to: edge.to, label: edge.label ?? "", points: [], style: edgeStyle() };
    }
    return link(source, target, edge);
  });
  return { nodes, edges };
}

function link(source: Placed, target: Placed, edge: FlowEdge): DrawnEdge {
  if (edge.exit === "top" || edge.exit === "bottom") {
    const exitY = edge.exit === "top" ? 0 : 1;
    const targetMidY = target.y + target.height / 2;
    return {
      from: source.id,
      to: target.id,
      label: edge.label ?? "",
      points: [{ x: source.x + source.width / 2, y: targetMidY }],
      style:
        edgeStyle() +
        `exitX=0.5;exitY=${exitY};entryX=0;entryY=0.5;` +
        `drawai=routed;`,
    };
  }
  const y = Math.min(
    source.y + Math.min(32, source.height / 2),
    target.y + target.height - 16,
    source.y + source.height - 16,
  );
  const yInSource = Math.min(Math.max(y, source.y + 12), source.y + source.height - 12);
  const yInTarget = Math.min(Math.max(yInSource, target.y + 12), target.y + target.height - 12);
  const shared = yInSource === yInTarget ? yInSource : source.y + 32;
  const exitY = (shared - source.y) / source.height;
  const entryY = (Math.min(Math.max(shared, target.y + 12), target.y + target.height - 12) - target.y) / target.height;
  return {
    from: source.id,
    to: target.id,
    label: edge.label ?? "",
    points: [],
    style: edgeStyle() + `exitX=1;exitY=${exitY.toFixed(3)};entryX=0;entryY=${entryY.toFixed(3)};drawai=routed;`,
  };
}

function drawLayers(spec: LayerSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  if (spec.axis === "horizontal") return drawHorizontalBands(spec, paint, force);
  if (spec.axis === "vertical") return drawVerticalBands(spec, paint, force);
  if (spec.groups.some((group) => group.flow === "row" && group.nodes.length > 1)) return drawRowLayers(spec, paint, force);
  return drawStackedLayers(spec, paint, force);
}

const BAND_HEADER = 34;
const BAND_PAD_X = 18;
const BAND_PAD_Y = 16;
const BAND_GAP = 64;

function clusterStyle(header: number): string {
  return (
    `swimlane;whiteSpace=wrap;html=1;startSize=${header};rounded=1;arcSize=8;` +
    `fillColor=${CLUSTER_HEADER};swimlaneFillColor=${CLUSTER_BODY};strokeColor=${CLUSTER_STROKE};` +
    `fontColor=#475569;fontSize=12;fontStyle=1;fontFamily=Helvetica;drawai=cluster;`
  );
}

/** A straight row edge would pass through a box that is not an endpoint. */
function rowEdgeCrosses(source: Placed, target: Placed, nodes: Placed[]): boolean {
  const y = (source.y + source.height / 2 + target.y + target.height / 2) / 2;
  const left = Math.min(source.x + source.width, target.x + target.width);
  const right = Math.max(source.x, target.x);
  if (right - left < 8) return false;
  return nodes.some((node) => {
    if (node.id === source.id || node.id === target.id) return false;
    if (node.x + node.width <= left || node.x >= right) return false;
    return y > node.y && y < node.y + node.height;
  });
}

/** Topic groups in a row. Edges run through the gap, so a taller tier does not cross its neighbor. */
function drawHorizontalBands(spec: LayerSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  const measured = spec.groups.map((group) => {
    const sizes = group.nodes.map((node) => sizeFor(node.shape));
    const stackH = sizes.reduce((sum, size) => sum + size.height, 0) + 20 * Math.max(0, sizes.length - 1);
    const innerW = Math.max(...sizes.map((size) => size.width), 150);
    return {
      sizes,
      stackH,
      width: BAND_PAD_X * 2 + innerW,
      height: BAND_HEADER + BAND_PAD_Y * 2 + stackH,
    };
  });
  const rowH = Math.max(...measured.map((band) => band.height), BAND_HEADER + BAND_PAD_Y * 2);
  const nodes: Placed[] = [];
  const midY = new Map<string, number>();
  let cursor = 80;
  spec.groups.forEach((group, index) => {
    const band = measured[index];
    if (!band) return;
    nodes.push({
      id: group.id,
      label: group.label,
      x: cursor,
      y: 72,
      width: band.width,
      height: rowH,
      style: clusterStyle(BAND_HEADER),
    });
    const contentTop = 72 + BAND_HEADER + BAND_PAD_Y;
    let nodeY = contentTop;
    group.nodes.forEach((node, nodeIndex) => {
      const size = band.sizes[nodeIndex] ?? sizeFor(node.shape);
      const nodeX = cursor + (band.width - size.width) / 2;
      nodes.push(placedNode(node, nodeX, nodeY, size, paint, force));
      midY.set(node.id, nodeY + size.height / 2);
      nodeY += size.height + 20;
    });
    cursor += band.width + BAND_GAP;
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const content = nodes.filter((node) => !node.style.includes("drawai=cluster"));
  const edges: DrawnEdge[] = spec.edges.map((edge) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) {
      return { from: edge.from, to: edge.to, label: edge.label, points: [], style: edgeStyle() };
    }
    if (rowEdgeCrosses(source, target, content)) {
      const laneY = 36;
      return {
        from: source.id,
        to: target.id,
        label: edge.label,
        points: [
          { x: Math.round(source.x + source.width / 2), y: laneY },
          { x: Math.round(target.x + target.width / 2), y: laneY },
        ],
        style: edgeStyle() + "exitX=0.500;exitY=0;entryX=0.500;entryY=0;drawai=routed;",
      };
    }
    const sourceMid = midY.get(edge.from) ?? source.y + source.height / 2;
    const targetMid = midY.get(edge.to) ?? target.y + target.height / 2;
    const forward = target.x >= source.x;
    const exitX = forward ? 1 : 0;
    const entryX = forward ? 0 : 1;
    const exitY = Math.min(0.85, Math.max(0.15, (sourceMid - source.y) / source.height));
    const entryY = Math.min(0.85, Math.max(0.15, (targetMid - target.y) / target.height));
    const points =
      Math.abs(sourceMid - targetMid) < 1
        ? []
        : [
            { x: Math.round((source.x + source.width + target.x) / 2), y: Math.round(sourceMid) },
            { x: Math.round((source.x + source.width + target.x) / 2), y: Math.round(targetMid) },
          ];
    return {
      from: source.id,
      to: target.id,
      label: edge.label,
      points,
      style:
        edgeStyle() +
        `exitX=${exitX};exitY=${exitY.toFixed(3)};entryX=${entryX};entryY=${entryY.toFixed(3)};drawai=routed;`,
    };
  });
  return { nodes, edges };
}

/** Topic groups in a column. Content nodes share an x so a repeat draw does not reflow them. */
function drawVerticalBands(spec: LayerSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  const gap = 56;
  const left = 80;
  const measured = spec.groups.map((group) => {
    const sizes = group.nodes.map((node) => sizeFor(node.shape));
    const stackH = sizes.reduce((sum, size) => sum + size.height, 0) + 20 * Math.max(0, sizes.length - 1);
    const innerW = Math.max(...sizes.map((size) => size.width), 150);
    return { sizes, stackH, innerW, height: BAND_HEADER + BAND_PAD_Y * 2 + stackH };
  });
  const innerW = Math.max(...measured.map((band) => band.innerW), 150);
  const clusterW = BAND_PAD_X * 2 + innerW;
  const nodes: Placed[] = [];
  let cursor = 48;
  spec.groups.forEach((group, index) => {
    const band = measured[index];
    if (!band) return;
    nodes.push({
      id: group.id,
      label: group.label,
      x: left,
      y: cursor,
      width: clusterW,
      height: band.height,
      style: clusterStyle(BAND_HEADER),
    });
    let nodeY = cursor + BAND_HEADER + BAND_PAD_Y;
    group.nodes.forEach((node, nodeIndex) => {
      const size = band.sizes[nodeIndex] ?? sizeFor(node.shape);
      nodes.push(placedNode(node, left + BAND_PAD_X, nodeY, size, paint, force));
      nodeY += size.height + 20;
    });
    cursor += band.height + gap;
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: DrawnEdge[] = spec.edges.map((edge) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) {
      return { from: edge.from, to: edge.to, label: edge.label, points: [], style: edgeStyle() };
    }
    const sourceCx = source.x + source.width / 2;
    const targetCx = target.x + target.width / 2;
    const exitX = Math.min(0.85, Math.max(0.15, (sourceCx - source.x) / source.width));
    const entryX = Math.min(0.85, Math.max(0.15, (targetCx - target.x) / target.width));
    const points =
      Math.abs(sourceCx - targetCx) < 1
        ? []
        : [
            { x: Math.round(sourceCx), y: Math.round((source.y + source.height + target.y) / 2) },
            { x: Math.round(targetCx), y: Math.round((source.y + source.height + target.y) / 2) },
          ];
    return {
      from: source.id,
      to: target.id,
      label: edge.label,
      points,
      style: edgeStyle() + `exitX=${exitX.toFixed(3)};exitY=1;entryX=${entryX.toFixed(3)};entryY=0;drawai=routed;`,
    };
  });
  return { nodes, edges };
}

/** Equal slots so a single node lines up with the middle of an odd row. */
const ROW_SLOT = 210;
const ROW_PAD_X = 28;
const ROW_HEADER = 34;
const ROW_PAD_Y = 20;
const ROW_CLUSTER_GAP = 56;
const ROW_CENTER = 520;

interface ClusterBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FRAME_HEADER = 36;
const FRAME_PAD = 18;

function drawRowLayers(spec: LayerSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  const nodes: Placed[] = [];
  const clusters = new Map<string, ClusterBox>();
  const nodeCluster = new Map<string, ClusterBox>();
  let cursor = 48;
  let openedFrame = false;

  for (const group of spec.groups) {
    if (spec.enclosure?.groups.includes(group.id) && !openedFrame) {
      cursor += FRAME_HEADER + FRAME_PAD + 20;
      openedFrame = true;
    }
    const row = group.flow === "row" && group.nodes.length > 1;
    const count = row ? group.nodes.length : 1;
    const width = ROW_PAD_X + count * ROW_SLOT + ROW_PAD_X;
    const sizes = group.nodes.map((node) => sizeFor(node.shape));
    const body = row
      ? Math.max(...sizes.map((size) => size.height))
      : sizes.reduce((sum, size) => sum + size.height, 0) + 36 * Math.max(0, sizes.length - 1);
    const height = ROW_HEADER + ROW_PAD_Y + body + ROW_PAD_Y;
    const x = ROW_CENTER - width / 2;
    const cluster: ClusterBox = { x, y: cursor, width, height };
    clusters.set(group.id, cluster);
    nodes.push({
      id: group.id,
      label: group.label,
      x,
      y: cursor,
      width,
      height,
      style:
        `swimlane;whiteSpace=wrap;html=1;startSize=${ROW_HEADER};rounded=1;arcSize=8;` +
        `fillColor=${CLUSTER_HEADER};swimlaneFillColor=${CLUSTER_BODY};strokeColor=${CLUSTER_STROKE};` +
        `fontColor=#475569;fontSize=12;fontStyle=1;fontFamily=Helvetica;drawai=cluster;`,
    });
    if (row) {
      group.nodes.forEach((node, index) => {
        const size = sizes[index] ?? sizeFor(node.shape);
        const nodeX = x + ROW_PAD_X + index * ROW_SLOT + (ROW_SLOT - size.width) / 2;
        const nodeY = cursor + ROW_HEADER + ROW_PAD_Y;
        nodes.push(placedNode(node, nodeX, nodeY, size, paint, force));
        nodeCluster.set(node.id, cluster);
      });
    } else {
      let nodeY = cursor + ROW_HEADER + ROW_PAD_Y;
      group.nodes.forEach((node, index) => {
        const size = sizes[index] ?? sizeFor(node.shape);
        const nodeX = x + ROW_PAD_X + (ROW_SLOT - size.width) / 2;
        nodes.push(placedNode(node, nodeX, nodeY, size, paint, force));
        nodeCluster.set(node.id, cluster);
        nodeY += size.height + 36;
      });
    }
    cursor += height + ROW_CLUSTER_GAP;
  }

  prependEnclosure(spec, nodes, clusters);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const laneX = Math.max(...nodes.filter((node) => node.style.includes("drawai=cluster")).map((node) => node.x + node.width)) + 56;
  const edges: DrawnEdge[] = spec.edges.map((edge) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    const sourceCluster = nodeCluster.get(edge.from);
    const targetCluster = nodeCluster.get(edge.to);
    if (!source || !target || !sourceCluster || !targetCluster) {
      return { from: edge.from, to: edge.to, label: edge.label, points: [], style: edgeStyle() };
    }
    return routeLayerEdge(source, target, edge, sourceCluster, targetCluster, laneX);
  });
  return { nodes, edges };
}

function placedNode(
  node: LayerNode,
  x: number,
  y: number,
  size: { width: number; height: number },
  paint: PalettePaint,
  force: boolean,
): Placed {
  return {
    id: node.id,
    label: node.label,
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height,
    style: nodeStyle(node.shape, nodePaint(node, paint, force), "node"),
  };
}

function prependEnclosure(spec: LayerSpec, nodes: Placed[], clusters: Map<string, ClusterBox>) {
  const enclosure = spec.enclosure;
  if (!enclosure) return;
  const boxes = enclosure.groups
    .map((id) => clusters.get(id))
    .filter((box): box is ClusterBox => Boolean(box));
  if (boxes.length === 0) return;
  const minX = Math.min(...boxes.map((box) => box.x)) - FRAME_PAD;
  const minY = Math.min(...boxes.map((box) => box.y)) - FRAME_PAD - FRAME_HEADER;
  const maxX = Math.max(...boxes.map((box) => box.x + box.width)) + FRAME_PAD;
  const maxY = Math.max(...boxes.map((box) => box.y + box.height)) + FRAME_PAD;
  nodes.unshift({
    id: enclosure.id,
    label: enclosure.label,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    style:
      `swimlane;whiteSpace=wrap;html=1;startSize=${FRAME_HEADER};rounded=1;arcSize=8;` +
      `fillColor=${CLUSTER_HEADER};swimlaneFillColor=${CLUSTER_BODY};strokeColor=${CLUSTER_STROKE};` +
      `fontColor=#475569;fontSize=12;fontStyle=1;fontFamily=Helvetica;drawai=cluster;`,
  });
}

function padLeft(nodes: Placed[], edges: DrawnEdge[], minX: number) {
  const xs = [...nodes.map((node) => node.x), ...edges.flatMap((edge) => edge.points.map((point) => point.x))];
  if (xs.length === 0) return;
  const min = Math.min(...xs);
  if (!Number.isFinite(min) || min >= minX) return;
  const dx = minX - min;
  for (const node of nodes) node.x += dx;
  for (const edge of edges) {
    for (const point of edge.points) point.x += dx;
  }
}

function routeLayerEdge(
  source: Placed,
  target: Placed,
  edge: LayerEdge,
  sourceCluster: ClusterBox,
  targetCluster: ClusterBox,
  laneX: number,
): DrawnEdge {
  if (sourceCluster === targetCluster && !edge.side) {
    const goRight = target.x + target.width / 2 >= source.x + source.width / 2;
    return {
      from: source.id,
      to: target.id,
      label: edge.label,
      points: [],
      style:
        edgeStyle() +
        `exitX=${goRight ? "1" : "0"};exitY=0.500;entryX=${goRight ? "0" : "1"};entryY=0.500;drawai=routed;`,
    };
  }
  if (edge.side) {
    const startY = source.y + source.height / 2;
    const endY = target.y + target.height / 2;
    return {
      from: source.id,
      to: target.id,
      label: edge.label,
      points: [
        { x: laneX, y: startY },
        { x: laneX, y: endY },
      ],
      style:
        "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;endArrow=open;endFill=0;" +
        "exitX=1;exitY=0.500;entryX=1;entryY=0.500;" +
        "strokeColor=#64748b;fontColor=#334155;fontSize=12;labelBackgroundColor=#ffffff;drawai=routed;",
    };
  }
  const sourceCx = source.x + source.width / 2;
  const targetCx = target.x + target.width / 2;
  const downward = target.y + target.height / 2 >= source.y + source.height / 2;
  if (Math.abs(sourceCx - targetCx) <= 6) {
    return {
      from: source.id,
      to: target.id,
      label: edge.label,
      points: [],
      style:
        edgeStyle() +
        `exitX=0.500;exitY=${downward ? 1 : 0};entryX=0.500;entryY=${downward ? 0 : 1};drawai=routed;`,
    };
  }
  const upper = downward ? sourceCluster : targetCluster;
  const lower = downward ? targetCluster : sourceCluster;
  const laneY = Math.round((upper.y + upper.height + lower.y) / 2);
  return {
    from: source.id,
    to: target.id,
    label: edge.label,
    points: [
      { x: Math.round(sourceCx), y: laneY },
      { x: Math.round(targetCx), y: laneY },
    ],
    style:
      edgeStyle() +
      `exitX=0.500;exitY=${downward ? 1 : 0};entryX=0.500;entryY=${downward ? 0 : 1};drawai=routed;`,
  };
}

function drawStackedLayers(spec: LayerSpec, paint: PalettePaint, force: boolean): { nodes: Placed[]; edges: DrawnEdge[] } {
  const innerW = 188;
  const padX = 28;
  const header = 34;
  const padY = 20;
  const gap = 28;
  const clusterGap = 40;
  const clusterW = padX + innerW + padX;
  const clusterX = 180;
  const nodes: Placed[] = [];
  let cursor = 40;

  for (const group of spec.groups) {
    const sizes = group.nodes.map((node) => sizeFor(node.shape));
    const body = sizes.reduce((sum, size) => sum + size.height, 0) + gap * Math.max(0, sizes.length - 1);
    const clusterH = header + padY + body + padY;
    nodes.push({
      id: group.id,
      label: group.label,
      x: clusterX,
      y: cursor,
      width: clusterW,
      height: clusterH,
      style:
        `swimlane;whiteSpace=wrap;html=1;startSize=${header};rounded=1;arcSize=8;` +
        `fillColor=${CLUSTER_HEADER};swimlaneFillColor=${CLUSTER_BODY};strokeColor=${CLUSTER_STROKE};` +
        `fontColor=#475569;fontSize=12;fontStyle=1;fontFamily=Helvetica;drawai=cluster;`,
    });
    let nodeY = cursor + header + padY;
    group.nodes.forEach((node, index) => {
      const size = sizes[index] ?? sizeFor(node.shape);
      nodes.push({
        id: node.id,
        label: node.label,
        x: clusterX + (clusterW - size.width) / 2,
        y: nodeY,
        width: size.width,
        height: size.height,
        style: nodeStyle(node.shape, nodePaint(node, paint, force), "node"),
      });
      nodeY += size.height + gap;
    });
    cursor += clusterH + clusterGap;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const laneX = clusterX + clusterW + 56;
  const edges: DrawnEdge[] = spec.edges.map((edge) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) {
      return { from: edge.from, to: edge.to, label: edge.label, points: [], style: edgeStyle() };
    }
    if (edge.side) {
      const startY = source.y + source.height / 2;
      const endY = target.y + target.height / 2;
      return {
        from: source.id,
        to: target.id,
        label: edge.label,
        points: [
          { x: laneX, y: startY },
          { x: laneX, y: endY },
        ],
        style:
          "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;endArrow=open;endFill=0;" +
          "exitX=1;exitY=0.500;entryX=1;entryY=0.500;" +
          "strokeColor=#64748b;fontColor=#334155;fontSize=12;labelBackgroundColor=#ffffff;drawai=routed;",
      };
    }
    const sourceCx = source.x + source.width / 2;
    const targetCx = target.x + target.width / 2;
    const sharedX = Math.abs(sourceCx - targetCx) < 2 ? sourceCx : (sourceCx + targetCx) / 2;
    const exitX = (sharedX - source.x) / source.width;
    const entryX = (sharedX - target.x) / target.width;
    const downward = target.y >= source.y;
    return {
      from: source.id,
      to: target.id,
      label: edge.label,
      points: [],
      style:
        edgeStyle() +
        `exitX=${exitX.toFixed(3)};exitY=${downward ? 1 : 0};entryX=${entryX.toFixed(3)};entryY=${downward ? 0 : 1};drawai=routed;`,
    };
  });
  return { nodes, edges };
}

function edgeStyle(): string {
  return (
    "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" +
    "endArrow=classic;endFill=1;strokeColor=#64748b;fontColor=#334155;fontSize=12;labelBackgroundColor=#ffffff;"
  );
}

function boxHolds(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
  slop = 2,
): boolean {
  return (
    inner.x >= outer.x - slop &&
    inner.y >= outer.y - slop &&
    inner.x + inner.width <= outer.x + outer.width + slop &&
    inner.y + inner.height <= outer.y + outer.height + slop
  );
}

/**
 * Children of a topic container are parented to it, with geometry relative to that cell.
 * Group ids can match a child id ("igw" cluster and "igw" node), so parenting is by index.
 */
function nestInContainers(nodes: Placed[]) {
  const origin = nodes.map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
  const parentOf = nodes.map(() => -1);
  nodes.forEach((node, index) => {
    const box = origin[index];
    if (!box) return;
    let parent = -1;
    let area = Infinity;
    for (let clusterIndex = 0; clusterIndex < nodes.length; clusterIndex += 1) {
      const cluster = nodes[clusterIndex];
      if (!cluster || cluster === node || !cluster.style.includes("drawai=cluster")) continue;
      const frame = origin[clusterIndex];
      if (!frame || !boxHolds(frame, box)) continue;
      const next = frame.width * frame.height;
      if (next < area) {
        parent = clusterIndex;
        area = next;
      }
    }
    parentOf[index] = parent;
  });
  nodes.forEach((node, index) => {
    const parent = parentOf[index] ?? -1;
    const at = parent >= 0 ? origin[parent] : undefined;
    const box = origin[index];
    if (!at || !box || parent < 0) return;
    node.parentIndex = parent;
    node.x = box.x - at.x;
    node.y = box.y - at.y;
  });
  // Same padding in every tier shares one local origin. A reader that ignores
  // parent then reports the tiers as overlapping. Give each tier its own local
  // band, and park the container to the right of those local boxes.
  separateNestedBands(nodes);
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function separateNestedBands(nodes: Placed[]) {
  const clusters = nodes
    .map((node, index) => ({ node, index }))
    .filter((item) => item.node.style.includes("drawai=cluster"));
  if (clusters.length === 0) return;
  const childrenOf = new Map<number, Placed[]>();
  for (const node of nodes) {
    if (node.parentIndex === undefined) continue;
    const list = childrenOf.get(node.parentIndex) ?? [];
    list.push(node);
    childrenOf.set(node.parentIndex, list);
  }
  const columns: Array<Array<{ node: Placed; index: number }>> = [];
  const byX = [...clusters].sort((a, b) => a.node.x - b.node.x || a.node.y - b.node.y);
  for (const cluster of byX) {
    const column = columns.find((group) =>
      group.some(
        (other) => cluster.node.x < other.node.x + other.node.width && other.node.x < cluster.node.x + cluster.node.width,
      ),
    );
    if (column) column.push(cluster);
    else columns.push([cluster]);
  }
  for (const column of columns) {
    column.sort((a, b) => a.node.y - b.node.y);
    let localY = 0;
    for (const cluster of column) {
      const children = childrenOf.get(cluster.index) ?? [];
      if (children.length === 0) continue;
      const minY = Math.min(...children.map((child) => child.y));
      const shiftY = Math.max(0, localY - minY);
      if (shiftY > 0) {
        for (const child of children) child.y += shiftY;
      }
      const needed = Math.max(...children.map((child) => child.y + child.height)) + 16;
      if (cluster.node.height < needed) cluster.node.height = needed;
      localY = Math.max(...children.map((child) => child.y + child.height)) + 36;
    }
  }
  // Side-by-side tiers are each their own column, so the loop above leaves them
  // on one local origin. Drop each later tier into the next local band and lift
  // its container by the same amount. The shapes stay on one row; a reader that
  // ignores parent no longer stacks them.
  const sideBySide = columns.filter((column) => column.length === 1).map((column) => column[0]!);
  const rows: Array<Array<{ node: Placed; index: number }>> = [];
  const across = [...sideBySide].sort((a, b) => a.node.y - b.node.y || a.node.x - b.node.x);
  for (const cluster of across) {
    const row = rows.find((group) =>
      group.some(
        (other) => cluster.node.y < other.node.y + other.node.height && other.node.y < cluster.node.y + cluster.node.height,
      ),
    );
    if (row) row.push(cluster);
    else rows.push([cluster]);
  }
  for (const row of rows) {
    if (row.length < 2) continue;
    row.sort((a, b) => a.node.x - b.node.x);
    let localY = 0;
    for (const cluster of row) {
      const children = childrenOf.get(cluster.index) ?? [];
      if (children.length === 0) continue;
      const minY = Math.min(...children.map((child) => child.y));
      const shiftY = Math.max(0, localY - minY);
      if (shiftY > 0) {
        for (const child of children) child.y += shiftY;
        cluster.node.y -= shiftY;
        cluster.node.height += shiftY;
      }
      const needed = Math.max(...children.map((child) => child.y + child.height)) + 16;
      if (cluster.node.height < needed) cluster.node.height = needed;
      localY = Math.max(...children.map((child) => child.y + child.height)) + 36;
    }
  }
  let maxLocalRight = 0;
  for (const children of childrenOf.values()) {
    for (const child of children) maxLocalRight = Math.max(maxLocalRight, child.x + child.width);
  }
  const minClusterX = Math.min(...clusters.map((cluster) => cluster.node.x));
  const dx = Math.max(0, maxLocalRight + 32 - minClusterX);
  if (dx > 0) {
    for (const cluster of clusters) cluster.node.x += dx;
  }
  const topLevel = nodes.filter((node) => node.parentIndex === undefined);
  if (topLevel.length > 0) {
    const minY = Math.min(...topLevel.map((node) => node.y));
    const lift = Math.max(0, 40 - minY);
    if (lift > 0) {
      for (const node of topLevel) node.y += lift;
    }
  }
  const byY = [...clusters].sort((a, b) => a.node.y - b.node.y || a.node.x - b.node.x);
  for (let pass = 0; pass < byY.length; pass += 1) {
    for (let index = 0; index < byY.length; index += 1) {
      const current = byY[index]?.node;
      if (!current) continue;
      for (let later = index + 1; later < byY.length; later += 1) {
        const other = byY[later]?.node;
        if (!other || !boxesOverlap(current, other)) continue;
        if (other.y >= current.y) other.y = current.y + current.height + 40;
        else current.y = other.y + other.height + 40;
      }
    }
  }
}

function xmlFor(nodes: Placed[], edges: DrawnEdge[], title: string): string {
  const doc = openDiagram(BLANK);
  const model = doc.getElementsByTagName("mxGraphModel")[0];
  const diagram = doc.getElementsByTagName("diagram")[0];
  if (diagram) {
    diagram.setAttribute("id", "diagram");
    diagram.setAttribute("name", title);
  }
  const root = doc.getElementsByTagName("root")[0];
  if (!root) return serializeDiagram(doc);
  let next = 2;
  const ids = new Map<string, string>();
  const before = nodes.map((node) => ({ x: node.x, y: node.y }));
  nestInContainers(nodes);
  const moved = new Map<string, { dx: number; dy: number }>();
  nodes.forEach((node, index) => {
    const old = before[index];
    if (!old) return;
    const parent = node.parentIndex !== undefined ? nodes[node.parentIndex] : undefined;
    const absX = parent ? parent.x + node.x : node.x;
    const absY = parent ? parent.y + node.y : node.y;
    moved.set(node.id, { dx: absX - old.x, dy: absY - old.y });
  });
  for (const edge of edges) {
    const source = moved.get(edge.from) ?? { dx: 0, dy: 0 };
    const target = moved.get(edge.to) ?? { dx: 0, dy: 0 };
    for (const point of edge.points) {
      point.x += (source.dx + target.dx) / 2;
      point.y += (source.dy + target.dy) / 2;
    }
  }
  let maxX = 1169;
  let maxY = 827;
  nodes.forEach((node) => {
    const parent = node.parentIndex !== undefined ? nodes[node.parentIndex] : undefined;
    const absX = parent ? parent.x + node.x : node.x;
    const absY = parent ? parent.y + node.y : node.y;
    maxX = Math.max(maxX, absX + node.width + 80);
    maxY = Math.max(maxY, absY + node.height + 80);
  });
  const mxIds: string[] = [];
  for (const node of nodes) {
    const id = String(next);
    next += 1;
    mxIds.push(id);
    // Edges address the content id. A later child with the same id wins over its frame.
    ids.set(node.id, id);
  }
  nodes.forEach((node, index) => {
    const id = mxIds[index];
    if (!id) return;
    const parentIndex = node.parentIndex;
    const parent = parentIndex === undefined ? "1" : (mxIds[parentIndex] ?? "1");
    root.appendChild(vertex(doc, id, node, parent));
  });
  for (const edge of edges) {
    const source = ids.get(edge.from);
    const target = ids.get(edge.to);
    if (!source || !target) continue;
    root.appendChild(edgeCell(doc, String(next), source, target, edge));
    next += 1;
    for (const point of edge.points) {
      maxX = Math.max(maxX, point.x + 40);
      maxY = Math.max(maxY, point.y + 40);
    }
  }
  if (model) {
    model.setAttribute("pageWidth", String(Math.ceil(maxX / 10) * 10));
    model.setAttribute("pageHeight", String(Math.ceil(maxY / 10) * 10));
  }
  return serializeDiagram(doc);
}

function vertex(doc: XmlDocument, id: string, node: Placed, parent = "1"): XmlElement {
  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", id);
  cell.setAttribute("value", node.label);
  cell.setAttribute("style", node.style);
  cell.setAttribute("vertex", "1");
  cell.setAttribute("parent", parent);
  const geometry = doc.createElement("mxGeometry");
  geometry.setAttribute("x", String(Math.round(node.x)));
  geometry.setAttribute("y", String(Math.round(node.y)));
  geometry.setAttribute("width", String(Math.round(node.width)));
  geometry.setAttribute("height", String(Math.round(node.height)));
  geometry.setAttribute("as", "geometry");
  cell.appendChild(geometry);
  return cell;
}

function edgeCell(doc: XmlDocument, id: string, source: string, target: string, edge: DrawnEdge): XmlElement {
  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", id);
  cell.setAttribute("value", edge.label);
  cell.setAttribute("style", edge.style);
  cell.setAttribute("edge", "1");
  cell.setAttribute("parent", "1");
  cell.setAttribute("source", source);
  cell.setAttribute("target", target);
  const geometry = doc.createElement("mxGeometry");
  geometry.setAttribute("relative", "1");
  geometry.setAttribute("as", "geometry");
  if (edge.points.length > 0) {
    const array = doc.createElement("Array");
    array.setAttribute("as", "points");
    for (const point of edge.points) {
      const mx = doc.createElement("mxPoint");
      mx.setAttribute("x", String(Math.round(point.x)));
      mx.setAttribute("y", String(Math.round(point.y)));
      array.appendChild(mx);
    }
    geometry.appendChild(array);
  }
  cell.appendChild(geometry);
  return cell;
}

const BLANK = `<mxfile host="embed.diagrams.net" agent="draw.ai" type="device">
  <diagram id="diagram" name="Diagram">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
