import { PALETTE, SHAPE_STYLE, applyColors, inferColorName, type ShapeKind } from "@/lib/drawio/styles";
import { diagramIsBlank, normalizeMxfile, openDiagram, serializeDiagram } from "@/lib/drawio/xml";
import { layoutDefault, requestedLayout, resolvePlan, withPalette } from "@/lib/kev/plan";
import { builtinBrief, redisDiagramRequest } from "@/lib/kev/research";
import { composeFromBrief, matchTemplate } from "@/lib/kev/templates";
import type { KevDecision } from "@/lib/kev/types";

type XmlElement = import("@xmldom/xmldom").Element;
type XmlDocument = import("@xmldom/xmldom").Document;

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
}

interface Placed {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: string;
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

/** Sequence, workflow, and layered diagrams the chain planner cannot express. */
export function resolveComposition(
  message: string,
  hints?: { colorName?: string | null; context?: string | null },
): Composition | null {
  const text = message.trim();
  if (!text || !wantsPicture(text)) return null;
  const matched = matchTemplate(text);
  const spec = specFor(text);
  if (!spec) return null;
  const named = colorInMessage(text);
  const brief = builtinBrief(text);
  return {
    spec,
    colorName: named ?? hints?.colorName ?? null,
    context: hints?.context ?? brief?.summary ?? matched?.context ?? null,
    researchQuery: brief ? "Redis" : null,
    layout: requestedLayout(text) ?? layoutDefault(spec.kind),
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
  const paint = forcedPaint(composition.colorName);
  const drawn = drawSpec(composition.spec, paint);
  padLeft(drawn.nodes, drawn.edges, 80);
  return xmlFor(drawn.nodes, drawn.edges, composition.spec.title);
}

function specFor(text: string): CompositionSpec | null {
  if (isIoUring(text)) return ioUringSpec();
  const matched = matchTemplate(text);
  if (matched) return matched.spec;
  if (redisDiagramRequest(text)) return redisUsageSpec();
  if (isLoginSequence(text)) return loginSequence(text);
  if (isSequence(text)) return genericSequence(text);
  if (isTaxWorkflow(text)) return taxWorkflow();
  if (isWorkflow(text)) return genericWorkflow(text);
  return null;
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

/** A named color paints every node. Otherwise each node gets a pastel from its label and shape. */
function forcedPaint(colorName: string | null): PalettePaint | null {
  if (!colorName) return null;
  const named = PALETTE[colorName];
  if (!named) return null;
  return { fill: named.fill, stroke: named.stroke, font: named.font ?? WIRE_FONT };
}

function nodePaint(label: string, shape: ShapeKind, forced: PalettePaint | null): PalettePaint {
  if (forced) return forced;
  const named = PALETTE[inferColorName(label, shape)];
  if (!named) return { fill: "#d5e8d4", stroke: "#82b366", font: WIRE_FONT };
  return { fill: named.fill, stroke: named.stroke, font: named.font ?? WIRE_FONT };
}

function nodeStyle(shape: ShapeKind, label: string, forced: PalettePaint | null, role: string): string {
  const paint = nodePaint(label, shape, forced);
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

function drawSpec(spec: CompositionSpec, paint: PalettePaint | null): { nodes: Placed[]; edges: DrawnEdge[] } {
  if (spec.kind === "sequence") return drawSequence(spec, paint);
  if (spec.kind === "workflow") return drawWorkflow(spec, paint);
  return drawLayers(spec, paint);
}

function drawSequence(spec: SequenceSpec, paint: PalettePaint | null): { nodes: Placed[]; edges: DrawnEdge[] } {
  const header = 56;
  const longest = spec.participants.reduce((max, participant) => Math.max(max, participant.label.length), 0);
  const width = Math.max(150, Math.min(210, Math.round(28 + longest * 7.2)));
  const column = Math.max(COLUMN, width + 56);
  const height = header + 48 + spec.messages.length * LANE + 28;
  const nodes: Placed[] = spec.participants.map((participant, index) => ({
    id: participant.id,
    label: participant.label,
    x: 80 + index * column,
    y: 40,
    width,
    height,
    style: (() => {
      const color = nodePaint(participant.label, participant.shape, paint);
      return (
        `shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;collapsible=0;` +
        `recursiveResize=0;outlineConnect=0;portConstraint=eastwest;size=${header};` +
        `fillColor=${color.fill};strokeColor=${color.stroke};fontColor=${color.font};` +
        `fontSize=13;fontFamily=Helvetica;drawai=node;`
      );
    })(),
  }));

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

function drawWorkflow(spec: WorkflowSpec, paint: PalettePaint | null): { nodes: Placed[]; edges: DrawnEdge[] } {
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
      style: nodeStyle(node.shape, node.label, paint, "node"),
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

function drawLayers(spec: LayerSpec, paint: PalettePaint | null): { nodes: Placed[]; edges: DrawnEdge[] } {
  if (spec.groups.some((group) => group.flow === "row" && group.nodes.length > 1)) return drawRowLayers(spec, paint);
  return drawStackedLayers(spec, paint);
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

function drawRowLayers(spec: LayerSpec, paint: PalettePaint | null): { nodes: Placed[]; edges: DrawnEdge[] } {
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
        nodes.push(placedNode(node, nodeX, nodeY, size, paint));
        nodeCluster.set(node.id, cluster);
      });
    } else {
      let nodeY = cursor + ROW_HEADER + ROW_PAD_Y;
      group.nodes.forEach((node, index) => {
        const size = sizes[index] ?? sizeFor(node.shape);
        const nodeX = x + ROW_PAD_X + (ROW_SLOT - size.width) / 2;
        nodes.push(placedNode(node, nodeX, nodeY, size, paint));
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
  paint: PalettePaint | null,
): Placed {
  return {
    id: node.id,
    label: node.label,
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height,
    style: nodeStyle(node.shape, node.label, paint, "node"),
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

function drawStackedLayers(spec: LayerSpec, paint: PalettePaint | null): { nodes: Placed[]; edges: DrawnEdge[] } {
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
        style: nodeStyle(node.shape, node.label, paint, "node"),
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
  let maxX = 1169;
  let maxY = 827;
  for (const node of nodes) {
    const id = String(next);
    next += 1;
    ids.set(node.id, id);
    root.appendChild(vertex(doc, id, node));
    maxX = Math.max(maxX, node.x + node.width + 80);
    maxY = Math.max(maxY, node.y + node.height + 80);
  }
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

function vertex(doc: XmlDocument, id: string, node: Placed): XmlElement {
  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", id);
  cell.setAttribute("value", node.label);
  cell.setAttribute("style", node.style);
  cell.setAttribute("vertex", "1");
  cell.setAttribute("parent", "1");
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
