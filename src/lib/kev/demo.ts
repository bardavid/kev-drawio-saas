import { PALETTE, inferColorName, inferShape, isShapeKind } from "@/lib/drawio/styles";
import type { KevClient } from "@/lib/kev/client";
import { applyOperations, edgeQuery } from "@/lib/kev/mutate";
import { compositionDecision, renderComposition, resolveComposition, sameMxfile, templateCanvasPlan } from "@/lib/kev/compose";
import { architectureDecision, isBareDraw, operationsForPlan, resolvePlan, withPalette } from "@/lib/kev/plan";
import { KEPT_CANVAS_REPLY, UNCHANGED_DIAGRAM_REPLY } from "@/lib/kev/reply";
import type { ChatMessage, DiagramOperation, DiagramSlots, KevDecision } from "@/lib/kev/types";

const COLOR_NAMES = Object.keys(PALETTE).join("|");
const COLOR_RE = new RegExp(`\\b(${COLOR_NAMES})\\b`, "i");
const HEX_RE = /#([0-9a-f]{6})\b/i;

const HELP = "Describe a diagram change.";

function decision(
  intent: KevDecision["intent"],
  reply: string,
  slots: DiagramSlots = {},
  operations: DiagramOperation[] = [],
): KevDecision {
  return { intent, reply, slots, operations, updatedXml: null };
}

function cleanNoun(value: string): string {
  let text = value.replace(/[?.!,;:]+$/g, "").replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:the|a|an)\s+/i, "");
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/\s+(?:box|shape|node|component|service|database|db|cache|queue)$/i, "").trim();
  }
  return text;
}

/** “Add a Redis…” names the shape. “Keep the existing layout” does not ask for a reflow. */
function isNamedAddition(text: string): boolean {
  return /^(?:please\s+)?(?:add|insert|place)\b/i.test(text.trim());
}

const SPECIAL: Record<string, string> = {
  api: "API",
  postgres: "Postgres",
  postgresql: "PostgreSQL",
  redis: "Redis",
  mysql: "MySQL",
  graphql: "GraphQL",
  grpc: "gRPC",
  s3: "S3",
  nginx: "Nginx",
  kafka: "Kafka",
  auth: "Auth",
  http: "HTTP",
  https: "HTTPS",
  sql: "SQL",
  db: "DB",
  ui: "UI",
  url: "URL",
  aws: "AWS",
  gcp: "GCP",
};

function titleLabel(input: string): string {
  const words = cleanNoun(input).split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return words
    .map((word) => {
      const key = word.toLowerCase().replace(/[^a-z0-9.+]/g, "");
      if (SPECIAL[key]) return SPECIAL[key];
      if (word.length > 1 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function namedColor(text: string): string | null {
  return text.match(COLOR_RE)?.[1]?.toLowerCase() ?? null;
}

function hexColor(text: string): string | null {
  const match = text.match(HEX_RE);
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

function isVagueTarget(value: string): boolean {
  return /^(it|this|that)$/i.test(value.trim());
}

const EDGE_WORD = "(arrows?|edges?|connectors?|lines?)";
const EDGE_PREFIX = "(?:(?:all|every|the|these|those)\\s+)*";
const DRAW_COMMAND =
  /^(?:please\s+)?(?:add|insert|create|draw|sketch|place|connect|build|architect|show|illustrate|map)\b/i;
const LAYOUT_ASIDE = /^(?:please\s+)?(?:do not|don't|dont|keep|leave|preserve|without)\b/i;

export interface EdgeRestyleRequest {
  word: string;
  colorName: string | null;
  fillColor: string | null;
  from: string | null;
  to: string | null;
}

function restyleText(message: string): string {
  const sentences = message.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !LAYOUT_ASIDE.test(sentence));
  return (kept.length > 0 ? kept : sentences).join(" ").trim();
}

function findRestyleColor(text: string): { token: string; index: number; length: number } | null {
  const named = text.match(COLOR_RE);
  const hex = text.match(HEX_RE);
  const namedAt = named?.index ?? -1;
  const hexAt = hex?.index ?? -1;
  if (namedAt === -1 && hexAt === -1) return null;
  if (hexAt !== -1 && (namedAt === -1 || hexAt < namedAt)) {
    return { token: `#${hex![1]!.toLowerCase()}`, index: hexAt, length: hex![0]!.length };
  }
  return { token: named![1]!.toLowerCase(), index: namedAt, length: named![0]!.length };
}

function edgeSubject(text: string, color: { index: number; length: number }): string {
  const raw = `${text.slice(0, color.index)} ${text.slice(color.index + color.length)}`;
  return raw
    .replace(/^(?:please\s+)?(?:change|make|turn|paint|color|colour|recolor|recolour|style|set)\s+/i, "")
    .replace(/\bplease\b/gi, " ")
    .replace(/\b(?:to|color|colour)\s*$/i, "")
    .replace(/[?.!,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namedNode(value: string): string | null {
  const cleaned = value
    .replace(/\b(?:do not|don't|dont|keep|leave|preserve|without)\b[\s\S]*$/i, "")
    .trim();
  const label = titleLabel(cleaned);
  if (!label || isVagueTarget(label) || edgeQuery(label)) return null;
  return label;
}

/**
 * “Make the arrows blue” restyles every edge.
 * “From Browser” / “into Redis” keep a named endpoint.
 * A draw or add is not a restyle.
 */
export function parseEdgeRestyle(message: string): EdgeRestyleRequest | null {
  const text = restyleText(message);
  if (!text || DRAW_COMMAND.test(text) || !new RegExp(`\\b${EDGE_WORD}\\b`, "i").test(text)) return null;
  const color = findRestyleColor(text);
  if (!color) return null;
  const subject = edgeSubject(text, color);
  const hex = color.token.startsWith("#") ? color.token : null;
  const colorName = hex ? null : color.token;
  const scope = parseEdgeSubject(subject);
  if (!scope) return null;
  return { word: scope.word, colorName, fillColor: hex, from: scope.from, to: scope.to };
}

function parseEdgeSubject(subject: string): { word: string; from: string | null; to: string | null } | null {
  const bare = subject.match(new RegExp(`^${EDGE_PREFIX}${EDGE_WORD}$`, "i"));
  if (bare?.[1]) return { word: bare[1].toLowerCase(), from: null, to: null };

  const fromTo = subject.match(
    new RegExp(
      `^${EDGE_PREFIX}${EDGE_WORD}\\s+(?:coming\\s+|going\\s+)?(?:from|out of|leaving)\\s+(?:the\\s+)?(.+?)\\s+(?:to|into|toward|towards)\\s+(?:the\\s+)?(.+)$`,
      "i",
    ),
  );
  if (fromTo?.[1] && fromTo[2] && fromTo[3]) {
    const from = namedNode(fromTo[2]);
    const to = namedNode(fromTo[3]);
    if (!from || !to) return null;
    return { word: fromTo[1].toLowerCase(), from, to };
  }

  const fromOnly = subject.match(
    new RegExp(
      `^${EDGE_PREFIX}${EDGE_WORD}\\s+(?:coming\\s+|going\\s+)?(?:from|out of|leaving)\\s+(?:the\\s+)?(.+)$`,
      "i",
    ),
  );
  if (fromOnly?.[1] && fromOnly[2]) {
    const from = namedNode(fromOnly[2]);
    if (!from) return null;
    return { word: fromOnly[1].toLowerCase(), from, to: null };
  }

  const into = subject.match(
    new RegExp(
      `^${EDGE_PREFIX}${EDGE_WORD}\\s+(?:going\\s+|coming\\s+)?(?:into|to|toward|towards|entering)\\s+(?:the\\s+)?(.+)$`,
      "i",
    ),
  );
  if (into?.[1] && into[2]) {
    const to = namedNode(into[2]);
    if (!to) return null;
    return { word: into[1].toLowerCase(), from: null, to };
  }

  const between = subject.match(
    new RegExp(`^${EDGE_PREFIX}${EDGE_WORD}\\s+between\\s+(?:the\\s+)?(.+?)\\s+and\\s+(?:the\\s+)?(.+)$`, "i"),
  );
  if (between?.[1] && between[2] && between[3]) {
    const from = namedNode(between[2]);
    const to = namedNode(between[3]);
    if (!from || !to) return null;
    return { word: between[1].toLowerCase(), from, to };
  }

  return null;
}

function edgeRestyleReply(parsed: EdgeRestyleRequest): string {
  const color = parsed.colorName ?? parsed.fillColor ?? "the new color";
  if (parsed.from && parsed.to) return `Set the ${parsed.word} from ${parsed.from} to ${parsed.to} to ${color}.`;
  if (parsed.from) return `Set the ${parsed.word} from ${parsed.from} to ${color}.`;
  if (parsed.to) return `Set the ${parsed.word} into ${parsed.to} to ${color}.`;
  return `Set the ${parsed.word} to ${color}.`;
}

/** Host-owned arrow restyle. Null when the message is not one. */
export function edgeRestyleDecision(message: string): KevDecision | null {
  const parsed = parseEdgeRestyle(message);
  if (!parsed) return null;
  const slots: DiagramSlots = {
    target: parsed.word,
    colorName: parsed.colorName,
    fillColor: parsed.fillColor,
  };
  if (parsed.from) slots.from = parsed.from;
  if (parsed.to) slots.to = parsed.to;
  const painted = withPalette(slots);
  return decision("style", edgeRestyleReply(parsed), painted, [{ intent: "style", slots: painted }]);
}

function isAllTarget(value: string): boolean {
  const text = value.trim().toLowerCase().replace(/[?.!,]+$/g, "").replace(/\s+/g, " ");
  return (
    /^(?:(?:all|every|the|of|a|an)\s+)*(?:boxes|shapes|nodes|them|everything|diagram)$/.test(text) ||
    /^(?:all|every)\s+(?:box|shape|node)$/.test(text)
  );
}

function shapeSlots(label: string, text: string): DiagramSlots {
  const kind = inferShape(label);
  const hex = hexColor(text);
  const color = namedColor(text);
  return {
    label,
    shape: isShapeKind(kind) ? kind : "rectangle",
    colorName: color ?? (hex ? null : inferColorName(label, kind)),
    fillColor: hex,
  };
}

export function decideDemo(message: string): KevDecision {
  const text = message.trim();
  const lower = text.toLowerCase();
  if (!text) return decision("clarify", HELP);
  if (isBareDraw(text)) {
    return decision(
      "clarify",
      "What should I draw? Name the shapes and how they connect, for example “Client → App → Postgres”.",
    );
  }

  if (
    /^(hi|hello|hey|help|what can you do|who are you)\b/.test(lower) &&
    !/\b(add|connect|delete|remove|make|rename|layout)\b/.test(lower)
  ) {
    return decision(
      "clarify",
      HELP,
    );
  }

  const utteredEdges = edgeRestyleDecision(text);
  if (utteredEdges) return utteredEdges;

  if (isNamedAddition(text)) return parseAdd(text);

  if (
    /\b(reflow|relayout|re-layout|arrange|organize|organise)\b/.test(lower) ||
    /\blay(?:out)?\b/.test(lower) ||
    /\blay (?:it |them |the diagram )?out\b/.test(lower)
  ) {
    const layout = /\b(vertical\w*|column|stack|top to bottom)\b/.test(lower) ? "vertical" : "horizontal";
    const slots: DiagramSlots = { layout };
    const direction = layout === "vertical" ? "a vertical column" : "a horizontal row";
    return decision("layout", `Reflowed the diagram into ${direction}.`, slots, [{ intent: "layout", slots }]);
  }

  const rename = text.match(/\brename\s+(?:the\s+)?(.+?)\s+to\s+(.+)$/i);
  if (rename?.[1] && rename[2]) {
    const target = titleLabel(rename[1]);
    const newLabel = titleLabel(rename[2]);
    if (isVagueTarget(target)) return decision("clarify", "Which shape should be renamed?");
    const slots: DiagramSlots = { target, newLabel };
    return decision("edit_shape", `Renamed ${target} to ${newLabel}.`, slots, [{ intent: "edit_shape", slots }]);
  }

  if (/\b(delete|remove|drop)\b/.test(lower) && !/\b(add|create|insert|draw)\b/.test(lower)) {
    const match = text.match(/\b(?:delete|remove|drop)\s+(?:the\s+)?(.+)$/i);
    const target = titleLabel(match?.[1] ?? "");
    if (!target || isVagueTarget(target)) return decision("clarify", "Which shape should I delete?");
    const slots: DiagramSlots = { target };
    return decision("delete_shape", `Removed ${target} and the edges attached to it.`, slots, [
      { intent: "delete_shape", slots },
    ]);
  }

  const colorCommand = text.match(
    new RegExp(
      `\\b(?:change|make|turn|paint|color|colour|recolor|recolour|style|set)\\s+(?:the\\s+)?(.+?)\\s+(?:(?:to|(?:color|colour))\\s+)?(${COLOR_NAMES}|#[0-9a-fA-F]{6})\\b`,
      "i",
    ),
  );
  if (colorCommand?.[1] && colorCommand[2] && !/\b(add|create|insert|draw)\b/.test(lower)) {
    const rawTarget = colorCommand[1].trim();
    const edges = edgeQuery(rawTarget);
    if (edges) {
      const colorToken = colorCommand[2].toLowerCase();
      const hex = colorToken.startsWith("#") ? colorToken : null;
      const slots = withPalette({
        target: edges,
        colorName: hex ? null : colorToken,
        fillColor: hex,
      });
      return decision("style", `Set the ${edges} to ${colorToken}.`, slots, [{ intent: "style", slots }]);
    }
    if (isAllTarget(rawTarget)) {
      const colorToken = colorCommand[2].toLowerCase();
      const hex = colorToken.startsWith("#") ? colorToken : null;
      const slots = withPalette({ target: null, colorName: hex ? null : colorToken, fillColor: hex });
      return decision("style", `Set every shape to ${colorToken}.`, slots, [{ intent: "style", slots }]);
    }
    const namedTarget = titleLabel(rawTarget);
    const colorToken = colorCommand[2].toLowerCase();
    const hex = colorToken.startsWith("#") ? colorToken : null;
    const colorName = hex ? null : colorToken;
    if (isVagueTarget(namedTarget)) {
      return decision("clarify", `Which shape should be ${colorToken}? Name it, for example “Make the API red.”`);
    }
    const slots = withPalette({
      target: isAllTarget(namedTarget) ? null : namedTarget,
      colorName,
      fillColor: hex,
    });
    const subject = slots.target ?? "every shape";
    return decision("style", `Set ${subject} to ${colorToken}.`, slots, [{ intent: "style", slots }]);
  }

  if (/\b(add|insert|create|draw|place)\b/.test(lower)) {
    return parseAdd(text);
  }

  const connectOnly = text.match(/\bconnect\s+(?:the\s+)?(.+?)\s+to\s+(?:the\s+)?(.+)$/i);
  if (connectOnly?.[1] && connectOnly[2]) {
    const from = titleLabel(connectOnly[1]);
    const to = titleLabel(connectOnly[2]);
    if (isVagueTarget(from) || isVagueTarget(to)) {
      return decision("clarify", "Name both shapes to connect, for example “Connect the client to Postgres.”");
    }
    const slots: DiagramSlots = { from, to };
    return decision("connect", `Connected ${from} to ${to}.`, slots, [{ intent: "connect", slots }]);
  }

  return decision("clarify", HELP);
}

function firstClause(value: string): string {
  const cut = value.search(/\.\s+/);
  const sentence = cut === -1 ? value : value.slice(0, cut);
  return sentence.replace(/[?.!]+$/g, "").trim();
}

function parseAdd(text: string): KevDecision {
  let rest = text.replace(/^(?:please\s+)?(?:add|insert|create|draw|place)\s+/i, "");
  rest = rest.replace(/^(?:a|an|the)\s+/i, "");
  rest = firstClause(rest);

  const between = rest.match(/^(.+?)\s+between\s+(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+)$/i);
  if (between?.[1] && between[2] && between[3]) {
    const label = titleLabel(between[1]);
    const from = titleLabel(between[2]);
    const to = titleLabel(between[3]);
    if (!label) {
      return decision("clarify", "What should I add? For example, “Add a Redis cache in front of the database.”");
    }
    const slots: DiagramSlots = { ...shapeSlots(label, text), from, to };
    return decision("add_shape", `Added ${label} between ${from} and ${to}.`, slots, [
      { intent: "add_shape", slots },
    ]);
  }

  let place: DiagramSlots["place"] = null;
  let from: string | null = null;
  let target: string | null = null;
  let to: string | null = null;

  const connectIt = rest.match(/^(.+?)\s+and\s+connect\s+(?:the\s+)?(.+?)\s+to\s+it\b(.*)$/i);
  const connected = rest.match(/^(.+?)\s+(?:connected|linked|wired)\s+to\s+(?:the\s+)?(.+)$/i);
  const before = rest.match(/^(.+?)\s+(?:in front of|ahead of|\bbefore\b)\s+(?:the\s+)?(.+)$/i);
  const after = rest.match(/^(.+?)\s+(?:behind|\bafter\b)\s+(?:the\s+)?(.+)$/i);

  if (connectIt?.[1] && connectIt[2]) {
    rest = connectIt[1];
    from = titleLabel(connectIt[2]);
  } else if (before?.[1] && before[2]) {
    rest = before[1];
    place = "before";
    target = titleLabel(before[2]);
  } else if (after?.[1] && after[2]) {
    rest = after[1];
    place = "after";
    from = titleLabel(after[2]);
  } else if (connected?.[1] && connected[2]) {
    rest = connected[1];
    from = titleLabel(connected[2]);
  }

  const label = titleLabel(rest);
  if (!label) {
    return decision("clarify", "What should I add? For example, “Add a Redis cache in front of the database.”");
  }
  const slots: DiagramSlots = {
    ...shapeSlots(label, text),
    from,
    to,
    target,
    place,
  };
  let reply = `Added ${label}`;
  if (place === "before" && target) reply += ` in front of ${target} and rewired the edges through it`;
  else if (from) reply += ` and connected ${from} to it`;
  reply += ".";
  return decision("add_shape", reply, slots, [{ intent: "add_shape", slots }]);
}

export class DemoKevClient implements KevClient {
  readonly mode = "demo" as const;

  async decide(input: { messages: ChatMessage[]; currentXml: string }): Promise<KevDecision> {
    const latest = [...input.messages].reverse().find((message) => message.role === "user");
    return decideDemo(latest?.content ?? "");
  }
}

function unchanged(xml: string, reply = UNCHANGED_DIAGRAM_REPLY): { decision: KevDecision; xml: string } {
  return {
    decision: { intent: "noop", reply, slots: {}, operations: [], updatedXml: null },
    xml,
  };
}

export function previewDemo(message: string, xml: string): { decision: KevDecision; xml: string } {
  const composed = resolveComposition(message);
  if (composed) {
    const rendered = renderComposition(composed);
    const canvas = templateCanvasPlan(xml, rendered);
    if (canvas === "unchanged") return unchanged(xml);
    if (canvas === "keep") return unchanged(xml, KEPT_CANVAS_REPLY);
    return { decision: compositionDecision(composed, rendered), xml: rendered };
  }
  const plan = resolvePlan(message);
  if (plan) {
    const operations = operationsForPlan(plan, xml);
    if (operations.length === 0) return unchanged(xml);
    const rendered = applyOperations(xml, operations);
    if (sameMxfile(rendered, xml)) return unchanged(xml);
    return { decision: architectureDecision(plan, operations), xml: rendered };
  }
  const result = decideDemo(message);
  if (result.operations.length === 0) return { decision: result, xml };
  return { decision: result, xml: applyOperations(xml, result.operations) };
}
