import { PALETTE, inferShape } from "@/lib/drawio/styles";
import { summarizeDiagram, type DiagramSummary } from "@/lib/drawio/xml";
import type { DiagramOperation, DiagramSlots, Intent, KevDecision } from "@/lib/kev/types";

/**
 * Closed-set labels the host can offer Jev.
 * System One cannot emit free text, so architecture nouns come from the user
 * message and this lexicon, then Jev accepts or rejects each edit.
 */
const LEXICON: Record<string, string> = {
  client: "Client",
  browser: "Browser",
  frontend: "Frontend",
  web: "Web",
  user: "User",
  app: "App",
  application: "Application",
  api: "API",
  server: "Server",
  backend: "Backend",
  service: "Service",
  gateway: "Gateway",
  auth: "Auth",
  worker: "Worker",
  cache: "Cache",
  redis: "Redis",
  queue: "Queue",
  kafka: "Kafka",
  postgres: "Postgres",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mongo: "Mongo",
  mongodb: "MongoDB",
  database: "Database",
  db: "DB",
  nginx: "Nginx",
  s3: "S3",
};

const GENERIC = new Set(["database", "db", "service", "server", "app", "web", "cache", "queue", "box", "node", "tier"]);
const WORD_NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
const COLOR_RE = new RegExp(`\\b(${Object.keys(PALETTE).join("|")})\\b`, "i");
const DRAW_VERB = /\b(draw|sketch|build|create|architect)\b/i;

export interface ArchitecturePlan {
  title: string | null;
  nodes: string[];
  colorName: string | null;
  layout: "horizontal" | "vertical" | null;
}

export interface PlanHints {
  colorName?: string | null;
  layout?: "horizontal" | "vertical" | null;
}

/** “draw” / “draw a diagram” with no nodes, colors, or connections. */
export function isBareDraw(message: string): boolean {
  const text = message.trim().toLowerCase().replace(/[.!?]+$/g, "").trim();
  if (!text || COLOR_RE.test(text) || /\b(horizontal|vertical)\b/.test(text)) return false;
  return /^(?:please\s+)?(?:draw|sketch|build|create)(?:\s+me)?(?:\s+(?:a|an|the))?(?:\s+(?:diagram|something|architecture|system))?$/.test(
    text,
  );
}

export function isArchitectureRequest(message: string): boolean {
  return parseArchitecture(message) !== null;
}

export function parseArchitecture(message: string): ArchitecturePlan | null {
  const text = message.trim();
  if (!text || isBareDraw(text)) return null;
  const hasVerb = DRAW_VERB.test(text);
  const hasArrow = /→|->|=>|—>|-->|–>/.test(text);
  const tiers = tierCount(text);
  if (!hasVerb && !hasArrow) return null;

  const cleaned = stripModifiers(text);
  const chain = labelsFromChain(cleaned);
  let nodes = chain.length >= 2 ? chain : labelsFromList(cleaned);
  nodes = expandTiers(nodes, tiers);
  nodes = uniqueLabels(nodes).slice(0, 8);
  if (nodes.length < 2) return null;
  if (!hasVerb && !hasArrow) return null;

  return {
    title: extractTitle(text, chain.length >= 2 ? chain : []),
    nodes,
    colorName: namedColor(text),
    layout: layoutOf(text),
  };
}

export function resolvePlan(message: string, hints?: PlanHints): ArchitecturePlan | null {
  const plan = parseArchitecture(message);
  if (!plan) return null;
  return {
    ...plan,
    colorName: plan.colorName ?? hints?.colorName ?? null,
    layout: plan.layout ?? hints?.layout ?? null,
  };
}

/** Ordered mutations that take the current diagram to the requested architecture. */
export function planOperations(message: string, xml: string, hints?: PlanHints): DiagramOperation[] {
  const plan = resolvePlan(message, hints);
  if (!plan) return [];
  return operationsForPlan(plan, xml);
}

export function operationsForPlan(plan: ArchitecturePlan, xml: string): DiagramOperation[] {
  const summary = summarizeDiagram(xml);
  const present = new Set(summary.vertices.map((vertex) => vertex.label.toLowerCase()));
  const edges = new Set(summary.edges.map((edge) => `${edge.from.toLowerCase()}->${edge.to.toLowerCase()}`));
  const operations: DiagramOperation[] = [];

  let previous: string | null = null;
  for (const label of plan.nodes) {
    const key = label.toLowerCase();
    if (!present.has(key)) {
      const from = previous && present.has(previous.toLowerCase()) ? previous : null;
      operations.push({
        intent: "add_shape",
        slots: {
          label,
          shape: inferShape(label),
          ...colorSlots(plan.colorName),
          from,
        },
      });
      present.add(key);
      if (from) edges.add(`${from.toLowerCase()}->${key}`);
    }
    previous = label;
  }

  for (let index = 0; index < plan.nodes.length - 1; index += 1) {
    const from = plan.nodes[index] ?? "";
    const to = plan.nodes[index + 1] ?? "";
    const edge = `${from.toLowerCase()}->${to.toLowerCase()}`;
    if (present.has(from.toLowerCase()) && present.has(to.toLowerCase()) && !edges.has(edge)) {
      operations.push({ intent: "connect", slots: { from, to } });
      edges.add(edge);
    }
  }

  if (plan.colorName && needsColor(summary, plan.colorName)) {
    operations.push({ intent: "style", slots: colorSlots(plan.colorName) });
  }
  if (plan.layout && !layoutSatisfied(summary, plan)) {
    operations.push({
      intent: "layout",
      slots: { layout: plan.layout, sequence: [...plan.nodes] },
    });
  }
  return operations;
}

export function describeOperation(operation: DiagramOperation): string {
  const slots = operation.slots;
  switch (operation.intent) {
    case "add_shape": {
      const kind = slots.shape ?? "shape";
      const color = slots.colorName ? ` in ${slots.colorName}` : "";
      const from = slots.from ? ` connected from ${slots.from}` : "";
      return `Add a ${kind} labeled ${slots.label ?? "a shape"}${color}${from}`;
    }
    case "edit_shape":
      return slots.newLabel
        ? `Rename ${slots.target ?? "the shape"} to ${slots.newLabel}`
        : `Update ${slots.target ?? "the shape"}`;
    case "delete_shape":
      return `Remove ${slots.target ?? slots.label ?? "the shape"}`;
    case "connect":
      return `Connect ${slots.from ?? "?"} to ${slots.to ?? "?"}`;
    case "style":
      return `Color the diagram ${slots.colorName ?? slots.fillColor ?? ""}`.trim();
    case "layout":
      return slots.layout === "vertical"
        ? "Lay the diagram out in a vertical column"
        : "Lay the diagram out in a horizontal row";
    default: {
      const exhaustive: never = operation.intent;
      return exhaustive;
    }
  }
}

export function withPalette(slots: DiagramSlots): DiagramSlots {
  if (!slots.colorName) return slots;
  const named = PALETTE[slots.colorName];
  if (!named) return slots;
  return {
    ...slots,
    fillColor: slots.fillColor || named.fill,
    strokeColor: slots.strokeColor || named.stroke,
  };
}

export function summarizePlan(
  plan: ArchitecturePlan,
  operations: DiagramOperation[],
): { intent: Intent; reply: string; slots: DiagramSlots } {
  const added = operations.find((operation) => operation.intent === "add_shape");
  const chain = plan.nodes.join(" → ");
  const extras: string[] = [];
  if (plan.colorName && operations.some((operation) => operation.intent === "style" || operation.slots.colorName)) {
    extras.push(`in ${plan.colorName}`);
  }
  if (plan.layout && operations.some((operation) => operation.intent === "layout")) {
    extras.push(plan.layout === "vertical" ? "stacked vertically" : "laid out horizontally");
  }
  const suffix = extras.length > 0 ? `, ${extras.join(", ")}` : "";
  const title = plan.title ? `${plan.title}: ` : "";
  const slots = withPalette({
    label: plan.title ?? added?.slots.label ?? plan.nodes[0] ?? null,
    shape: added?.slots.shape ?? "rectangle",
    from: plan.nodes[0] ?? null,
    to: plan.nodes[plan.nodes.length - 1] ?? null,
    colorName: plan.colorName,
    layout: plan.layout,
  });
  return {
    intent: primaryIntent(operations),
    reply: `Drew ${title}${chain}${suffix}.`,
    slots,
  };
}

export function architectureDecision(plan: ArchitecturePlan, operations: DiagramOperation[]): KevDecision {
  const described = summarizePlan(plan, operations);
  return {
    intent: described.intent,
    reply: described.reply,
    slots: described.slots,
    operations,
    updatedXml: null,
  };
}

function primaryIntent(operations: DiagramOperation[]): Intent {
  if (operations.some((operation) => operation.intent === "add_shape")) return "add_shape";
  if (operations.some((operation) => operation.intent === "connect")) return "connect";
  if (operations.some((operation) => operation.intent === "style")) return "style";
  if (operations.some((operation) => operation.intent === "layout")) return "layout";
  return "noop";
}

function colorSlots(colorName: string | null): Pick<DiagramSlots, "colorName" | "fillColor" | "strokeColor"> {
  if (!colorName || !PALETTE[colorName]) return { colorName: null, fillColor: null, strokeColor: null };
  return { colorName, fillColor: PALETTE[colorName].fill, strokeColor: PALETTE[colorName].stroke };
}

function needsColor(summary: DiagramSummary, colorName: string): boolean {
  const color = PALETTE[colorName];
  if (!color || summary.vertices.length === 0) return false;
  return summary.vertices.some((vertex) => !vertex.style.includes(`fillColor=${color.fill}`));
}

function layoutSatisfied(summary: DiagramSummary, plan: ArchitecturePlan): boolean {
  if (!plan.layout || plan.nodes.length === 0) return true;
  const byLabel = new Map(summary.vertices.map((vertex) => [vertex.label.toLowerCase(), vertex]));
  if (!plan.nodes.every((node) => byLabel.has(node.toLowerCase()))) return false;
  const ordered = [...summary.vertices].sort((left, right) =>
    plan.layout === "vertical" ? left.y - right.y || left.x - right.x : left.x - right.x || left.y - right.y,
  );
  const indexes = plan.nodes.map((label) => ordered.findIndex((vertex) => vertex.label.toLowerCase() === label.toLowerCase()));
  for (let index = 1; index < indexes.length; index += 1) {
    if ((indexes[index] ?? -1) <= (indexes[index - 1] ?? -1)) return false;
  }
  if (plan.layout === "horizontal") return new Set(summary.vertices.map((vertex) => vertex.y)).size === 1;
  return new Set(summary.vertices.map((vertex) => vertex.x)).size === 1;
}

function namedColor(text: string): string | null {
  return text.match(COLOR_RE)?.[1]?.toLowerCase() ?? null;
}

function layoutOf(text: string): "horizontal" | "vertical" | null {
  const lower = text.toLowerCase();
  if (/\b(vertical\w*|column|stack|top to bottom)\b/.test(lower)) return "vertical";
  if (/\b(horizontal\w*|left to right|row)\b/.test(lower)) return "horizontal";
  return null;
}

function tierCount(text: string): number | null {
  const match = text.match(/\b(\d+|two|three|four|five)[\s-]*tier\b/i);
  if (!match?.[1]) return null;
  const raw = match[1].toLowerCase();
  const count = WORD_NUM[raw] ?? Number(raw);
  if (!Number.isFinite(count) || count < 2 || count > 6) return null;
  return count;
}

function stripModifiers(text: string): string {
  return text
    .replace(/\b(horizontally|horizontal|vertically|vertical|column|stack|left to right|top to bottom)\b/gi, " ")
    .replace(COLOR_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function labelsFromChain(text: string): string[] {
  const arrowed = text.replace(/\s*(?:→|->|=>|—>|-->|–>)\s*/g, " | ");
  let parts: string[];
  if (arrowed.includes("|")) parts = arrowed.split("|");
  else if (/\bto\b/i.test(arrowed)) parts = arrowed.split(/\s+\bto\b\s+/i);
  else return [];
  const usable = parts.map((part) => part.trim()).filter(Boolean);
  const labels = usable.map((part) => endpointLabel(part));
  if (labels.some((label) => !label)) return [];
  return labels.filter((label): label is string => Boolean(label));
}

function labelsFromList(text: string): string[] {
  if (!/,|\band\b/i.test(text)) return [];
  const stripped = text.replace(/^(?:please\s+)?(?:draw|sketch|build|create|architect)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "");
  const parts = stripped
    .split(/\s*,\s*|\s+\band\b\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return [];
  const labels = parts.map((part) => endpointLabel(part));
  if (labels.some((label) => !label)) return [];
  return labels.filter((label): label is string => Boolean(label));
}

function endpointLabel(fragment: string): string | null {
  let text = fragment.trim();
  const colon = Math.max(text.lastIndexOf(":"), text.lastIndexOf("："));
  if (colon !== -1) text = text.slice(colon + 1);
  text = text.replace(/^(?:please\s+)?(?:draw|sketch|build|create|make|architect)\s+(?:me\s+)?(?:a|an|the)?\s*/i, "");
  const words = text
    .replace(/[,.].*/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);
  const hits: string[] = [];
  for (const word of words) {
    const known = LEXICON[word.toLowerCase()];
    if (known) hits.push(known);
  }
  const specific = [...hits].reverse().find((hit) => !GENERIC.has(hit.toLowerCase()));
  if (specific) return specific;
  if (hits.length > 0) return hits[hits.length - 1] ?? null;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    if (word.length < 2 || /^(tier|complex|draw|please)$/i.test(word)) continue;
    if (/^\d+$/.test(word)) continue;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return null;
}

function expandTiers(nodes: string[], tiers: number | null): string[] {
  if (!tiers) return nodes;
  if (nodes.length === 0) return defaultStack(tiers);
  if (nodes.length >= tiers) return nodes;
  if (nodes.length === 1) {
    const only = nodes[0] ?? "App";
    const stack = defaultStack(tiers);
    if (inferShape(only) === "cylinder") return [...stack.slice(0, Math.max(0, tiers - 1)), only];
    return [only, ...stack.slice(1)];
  }
  const middles: string[] = [];
  const used = new Set(nodes.map((node) => node.toLowerCase()));
  const pool = ["App", "API", "Service", "Web", "Worker"];
  for (let index = 0; index < tiers - nodes.length; index += 1) {
    const name = pool.find((candidate) => !used.has(candidate.toLowerCase())) ?? `Tier ${index + 2}`;
    used.add(name.toLowerCase());
    middles.push(name);
  }
  return [nodes[0] ?? "Client", ...middles, nodes[nodes.length - 1] ?? "Postgres"];
}

function defaultStack(tiers: number): string[] {
  if (tiers <= 2) return ["Client", "API"];
  const middles = ["App"];
  for (let index = 1; index < tiers - 2; index += 1) middles.push(`Service ${index + 1}`);
  return ["Client", ...middles, "Postgres"];
}

function uniqueLabels(nodes: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const node of nodes) {
    const key = node.toLowerCase();
    if (!node || seen.has(key)) continue;
    seen.add(key);
    unique.push(node);
  }
  return unique;
}

function extractTitle(message: string, nodes: string[]): string | null {
  const withoutVerb = message
    .replace(/^(?:please\s+)?(?:draw|sketch|build|create|make|architect)\s+(?:me\s+)?(?:a|an|the)?\s*/i, "")
    .trim();
  let raw: string | null = null;
  const colon = withoutVerb.search(/[:：]/);
  if (colon !== -1) raw = withoutVerb.slice(0, colon);
  else {
    const tier = withoutVerb.match(
      /((?:complex\s+)?(?:\d+|two|three|four|five)[\s-]*tier(?:\s+(?!to\b)[a-z0-9]+){0,3})/i,
    );
    if (tier?.[1]) raw = tier[1];
  }
  if (!raw) return null;
  let title = displayLabel(raw);
  for (const node of nodes) {
    title = title.replace(new RegExp(`\\b${escapeRegExp(node)}\\b`, "ig"), " ");
  }
  title = title.replace(/\s+/g, " ").replace(/^[\s,;:→\-]+|[\s,;:→\-]+$/g, "").trim();
  if (title.length < 3) return null;
  return title;
}

function displayLabel(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const key = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (LEXICON[key]) return LEXICON[key];
      if (/^\d+$/.test(word)) return word;
      if (word.length > 1 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
