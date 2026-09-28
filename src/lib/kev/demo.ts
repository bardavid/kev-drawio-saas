import { PALETTE, inferColorName, inferShape, isShapeKind } from "@/lib/drawio/styles";
import type { KevClient } from "@/lib/kev/client";
import { applyOperations, edgeQuery, groundDecision } from "@/lib/kev/mutate";
import { OPEN_IDEA_REPLY } from "@/lib/kev/scale";
import {
  CAPACITY_REPLY,
  composeOnCanvas,
  hostPreparedComposition,
  renderBlankArchitecture,
  renderComposition,
  resolveComposition,
  unresolvedOpenIdea,
  sameMxfile,
  overNamedCapacity,
} from "@/lib/kev/compose";
import { placeExpansion } from "@/lib/kev/expand";
import { labeledPlacement } from "@/lib/kev/entities";
import {
  architectureDecision,
  isBareDraw,
  isBetweenEdit,
  operationsForPlan,
  PLACEMENT_MANNER_TOKENS,
  resolvePlan,
  withPalette,
} from "@/lib/kev/plan";
import { KEPT_CANVAS_REPLY, UNCHANGED_DIAGRAM_REPLY } from "@/lib/kev/reply";
import type { ChatMessage, DiagramOperation, DiagramSlots, KevDecision } from "@/lib/kev/types";

const COLOR_ALIAS: Record<string, string> = { violet: "purple" };
const COLOR_NAMES = [...new Set([...Object.keys(PALETTE), ...Object.keys(COLOR_ALIAS)])].join("|");
const COLOR_RE = new RegExp(`\\b(${COLOR_NAMES})\\b`, "i");

function canonicalColor(name: string): string {
  const key = name.toLowerCase();
  return COLOR_ALIAS[key] ?? key;
}
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

function cleanNoun(value: string, preserveTail = false): string {
  let text = value.replace(/[?.!,;:]+$/g, "").replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:the|a|an)\s+/i, "");
  if (preserveTail) return text;
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/\s+(?:box|shape|node|component|service|database|db|cache|queue|stage|sitting)$/i, "").trim();
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

function titleLabel(input: string, preserveTail = false): string {
  const words = cleanNoun(input, preserveTail).split(/\s+/).filter(Boolean);
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
  const raw = text.match(COLOR_RE)?.[1]?.toLowerCase() ?? null;
  if (!raw || raw.startsWith("#")) return null;
  const name = canonicalColor(raw);
  return PALETTE[name] ? name : null;
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
  /** Words the user said (“hot pink”), when they differ from the palette name. */
  phrase: string | null;
  from: string | null;
  to: string | null;
}

function restyleText(message: string): string {
  const sentences = message.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !LAYOUT_ASIDE.test(sentence));
  return (kept.length > 0 ? kept : sentences).join(" ").trim();
}

/**
 * Words that intensify a color. “hot pink” and “hot-pink” are the pink root,
 * not a new palette key for every synonym.
 */
const COLOR_MODIFIERS = new Set([
  "hot",
  "light",
  "dark",
  "deep",
  "bright",
  "neon",
  "vivid",
  "electric",
  "pale",
  "soft",
  "shocking",
  "pure",
  "true",
  "baby",
  "pastel",
  "medium",
  "ultra",
  "extra",
  "fluorescent",
  "candy",
  "bubblegum",
  "shock",
]);

/**
 * Edge colors resolve by hue family, not by one synonym at a time.
 * A spoken sample joins the nearest family whose center is within radius.
 * Amber, gold, orange, and goldenrod sit near hue 40 (±25) and share the orange stroke.
 * Coral, salmon, and tomato sit near hue 16 (about 0–25) and share the coral stroke.
 * Those bands do not overlap: coral is not amber, and goldenrod is not coral.
 * Pink, magenta, fuchsia, and hot-pink sit near hue 300 (±40).
 * Palette pink’s own stroke is outside that band, so the spoken sample is a
 * pink inside it and the edge uses the family stroke.
 * Cyan, teal, and any palette stroke already inside its own family stay put.
 */
const HUE_FAMILIES: Array<{ colorName: string; center: number; radius: number }> = [
  { colorName: "magenta", center: 300, radius: 40 },
  // Center 12, radius 13 covers hue 0–25, including the wrap from 359.
  // Hue 16 (coral) is nearer this center than the amber center at 40.
  { colorName: "coral", center: 12, radius: 13 },
  { colorName: "orange", center: 40, radius: 25 },
];

/** Representative sRGB for spoken names. Hue is computed from the sample. */
const SPOKEN_COLOR_HEX: Record<string, string> = {
  amber: "#ffbf00",
  gold: "#ffd700",
  golden: "#ffd700",
  goldenrod: "#daa520",
  darkorange: "#ff8c00",
  coral: "#ff7f50",
  salmon: "#fa8072",
  tomato: "#ff6347",
  pink: "#ff69b4",
  hotpink: "#ff69b4",
  magenta: "#c026d3",
  fuchsia: "#ff00ff",
  rose: "#ff007f",
  cerise: "#ff1493",
};

function hexHue(hex: string): number {
  const raw = hex.replace("#", "");
  const red = parseInt(raw.slice(0, 2), 16) / 255;
  const green = parseInt(raw.slice(2, 4), 16) / 255;
  const blue = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return hue;
}

function hueDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return Math.min(delta, 360 - delta);
}

function familyForHue(hue: number): { colorName: string; center: number; radius: number } | null {
  let best: { colorName: string; center: number; radius: number } | null = null;
  let bestDist = Infinity;
  for (const family of HUE_FAMILIES) {
    const dist = hueDistance(hue, family.center);
    if (dist <= family.radius && dist < bestDist) {
      best = family;
      bestDist = dist;
    }
  }
  return best;
}

function spokenHue(word: string): number | null {
  const sample = SPOKEN_COLOR_HEX[word];
  if (sample) return hexHue(sample);
  const palette = PALETTE[canonicalColor(word)];
  if (!palette) return null;
  return hexHue(palette.stroke);
}

interface ColorSpan {
  token: string;
  index: number;
  length: number;
  colorName: string | null;
  phrase: string | null;
}

function resolveColorWord(word: string, phrase: string): { colorName: string; phrase: string } | null {
  const hue = spokenHue(word);
  const paletteKey = PALETTE[canonicalColor(word)] ? canonicalColor(word) : null;
  const family = hue === null ? null : familyForHue(hue);
  if (paletteKey && family) {
    const stroke = PALETTE[paletteKey]!.stroke;
    const canonical = PALETTE[family.colorName]!.stroke;
    const strokeInFamily = hueDistance(hexHue(stroke), family.center) <= family.radius;
    if (strokeInFamily && (paletteKey === family.colorName || stroke.toLowerCase() !== canonical.toLowerCase())) {
      return { colorName: paletteKey, phrase: phrase === word ? paletteKey : phrase };
    }
    return { colorName: family.colorName, phrase };
  }
  if (family) return { colorName: family.colorName, phrase };
  if (paletteKey) return { colorName: paletteKey, phrase: phrase === word ? paletteKey : phrase };
  return null;
}

function resolveSpokenColor(rawParts: string[]): { colorName: string; phrase: string } | null {
  const parts = rawParts.flatMap((part) => part.toLowerCase().split("-")).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;
  const phrase = rawParts.join(" ").toLowerCase();
  if (parts.length === 1) return resolveColorWord(parts[0] ?? "", parts[0] ?? "");
  const compact = parts.join("");
  if (SPOKEN_COLOR_HEX[compact] || PALETTE[canonicalColor(compact)]) {
    const hit = resolveColorWord(compact, phrase);
    if (hit) return hit;
  }
  const root = parts[parts.length - 1] ?? "";
  const heads = parts.slice(0, -1);
  if (!heads.every((word) => COLOR_MODIFIERS.has(word))) return null;
  return resolveColorWord(root, phrase);
}

function findRestyleColor(text: string): ColorSpan | null {
  const tokens = [...text.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)*|#[0-9a-fA-F]{6}/g)];
  let best: ColorSpan | null = null;
  const consider = (hit: ColorSpan) => {
    if (!best) {
      best = hit;
      return;
    }
    const bestHex = best.token.startsWith("#");
    const hitHex = hit.token.startsWith("#");
    if (bestHex !== hitHex) {
      if (hit.index < best.index) best = hit;
      return;
    }
    if (hit.length > best.length || (hit.length === best.length && hit.index < best.index)) best = hit;
  };
  for (let end = 0; end < tokens.length; end += 1) {
    const last = tokens[end];
    if (!last || last.index === undefined) continue;
    if (last[0].startsWith("#")) {
      consider({
        token: `#${last[0].slice(1).toLowerCase()}`,
        index: last.index,
        length: last[0].length,
        colorName: null,
        phrase: null,
      });
      continue;
    }
    for (let start = end; start >= Math.max(0, end - 3); start -= 1) {
      let contiguous = true;
      for (let cursor = start; cursor < end; cursor += 1) {
        const left = tokens[cursor];
        const right = tokens[cursor + 1];
        if (!left || !right || left.index === undefined || right.index === undefined) {
          contiguous = false;
          break;
        }
        const gap = text.slice(left.index + left[0].length, right.index);
        if (!/^[\s-]+$/.test(gap)) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) continue;
      const slice = tokens.slice(start, end + 1);
      const resolved = resolveSpokenColor(slice.map((token) => token[0]));
      const first = slice[0];
      if (!resolved || !first || first.index === undefined) continue;
      const index = first.index;
      const length = last.index + last[0].length - index;
      consider({
        token: text.slice(index, index + length),
        index,
        length,
        colorName: resolved.colorName,
        phrase: resolved.phrase,
      });
    }
  }
  return best;
}

const RESTYLE_LEAD =
  /^(?:please\s+)?(?:change|make|turn|paint|tint|color|colour|recolor|recolour|restyle|style|set|wash|dye)\s+/i;

function edgeSubject(text: string, color: { index: number; length: number }): string {
  const raw = `${text.slice(0, color.index)} ${text.slice(color.index + color.length)}`;
  let subject = raw
    .replace(RESTYLE_LEAD, "")
    .replace(/\bplease\b/gi, " ")
    .replace(/\b(?:to|color|colour|in)\s*$/i, "")
    .replace(/[?.!,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // “edge stroke” names the connector stroke. The extra word is not an endpoint.
  if (new RegExp(`\\b${EDGE_WORD}\\b`, "i").test(subject)) subject = subject.replace(/\bstrokes?\b/gi, " ");
  else subject = subject.replace(/\bstrokes?\b/gi, "edges");
  return subject.replace(/\s+/g, " ").trim();
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
  if (!text || DRAW_COMMAND.test(text) || !new RegExp(`\\b(?:${EDGE_WORD}|strokes?)\\b`, "i").test(text)) return null;
  const color = findRestyleColor(text);
  if (!color) return null;
  const subject = edgeSubject(text, color);
  const hex = color.token.startsWith("#") ? color.token : null;
  const colorName = hex ? null : color.colorName;
  const scope = parseEdgeSubject(subject) ?? parseEdgeSubject(subject.replace(/^\S+\s+/, ""));
  if (!scope) return null;
  return { word: scope.word, colorName, fillColor: hex, phrase: hex ? null : color.phrase, from: scope.from, to: scope.to };
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
  const color = parsed.phrase ?? parsed.colorName ?? parsed.fillColor ?? "the new color";
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

/** Host-owned fill change. Null when the message is not recoloring shapes. */
export function shapeRestyleDecision(message: string): KevDecision | null {
  const text = message.trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  const colorCommand = text.match(
    new RegExp(
      `\\b(?:change|make|turn|paint|color|colour|recolor|recolour|restyle|style|set)\\s+(?:the\\s+)?(.+?)\\s+(?:(?:to|(?:color|colour))\\s+)?(${COLOR_NAMES}|#[0-9a-fA-F]{6})\\b`,
      "i",
    ),
  );
  if (!colorCommand?.[1] || !colorCommand[2] || /\b(add|create|insert|draw)\b/.test(lower)) return null;
  const rawTarget = colorCommand[1].trim();
  const edges = edgeQuery(rawTarget);
  if (edges) {
    const colorToken = canonicalColor(colorCommand[2].toLowerCase());
    const hex = colorCommand[2].startsWith("#") ? colorCommand[2].toLowerCase() : null;
    const slots = withPalette({
      target: edges,
      colorName: hex ? null : colorToken,
      fillColor: hex,
    });
    return decision("style", `Set the ${edges} to ${colorToken}.`, slots, [{ intent: "style", slots }]);
  }
  if (isAllTarget(rawTarget)) {
    const colorToken = canonicalColor(colorCommand[2].toLowerCase());
    const hex = colorCommand[2].startsWith("#") ? colorCommand[2].toLowerCase() : null;
    const slots = withPalette({ target: null, colorName: hex ? null : colorToken, fillColor: hex });
    return decision("style", `Set every shape to ${colorToken}.`, slots, [{ intent: "style", slots }]);
  }
  const namedTarget = titleLabel(rawTarget);
  const colorToken = canonicalColor(colorCommand[2].toLowerCase());
  const hex = colorCommand[2].startsWith("#") ? colorCommand[2].toLowerCase() : null;
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

  if (isBetweenEdit(text) || isNamedAddition(text)) return parseAdd(text);
  if (
    /^(?:please\s+)?(?:put|drop)\b/i.test(text) &&
    /\b(?:between|in front of|ahead of|before|behind|after)\b/i.test(text)
  ) {
    return parseAdd(text);
  }

  if (
    !labeledPlacement(text) &&
    (/\b(reflow|relayout|re-layout|arrange|organize|organise)\b/.test(lower) ||
      /\blay(?:out)?\b/.test(lower) ||
      /\blay (?:it |them |the diagram )?out\b/.test(lower))
  ) {
    const layout = /\b(vertical\w*|column|stack|top to bottom)\b/.test(lower) ? "vertical" : "horizontal";
    const slots: DiagramSlots = { layout };
    const direction = layout === "vertical" ? "a vertical column" : "a horizontal row";
    return decision("layout", `Reflowed the diagram into ${direction}.`, slots, [{ intent: "layout", slots }]);
  }

  const rename = parseRename(text);
  if (rename) {
    const target = titleLabel(rename.target);
    // The new name is what the user said. "Branch Node" keeps Node; the target still drops a trailing "node".
    const newLabel = titleLabel(rename.next, true);
    if (isVagueTarget(target)) return decision("clarify", "Which shape should be renamed?");
    const slots: DiagramSlots = { target, newLabel };
    return decision("edit_shape", `Renamed ${target} to ${newLabel}.`, slots, [{ intent: "edit_shape", slots }]);
  }

  if (!labeledPlacement(text) && /\b(delete|remove|drop)\b/.test(lower) && !/\b(add|create|insert|draw)\b/.test(lower)) {
    const match = text.match(/\b(?:delete|remove|drop)\s+(?:the\s+)?(.+)$/i);
    const target = titleLabel(match?.[1] ?? "");
    if (!target || isVagueTarget(target)) return decision("clarify", "Which shape should I delete?");
    const slots: DiagramSlots = { target };
    return decision("delete_shape", `Removed ${target} and the edges attached to it.`, slots, [
      { intent: "delete_shape", slots },
    ]);
  }

  const restyle = shapeRestyleDecision(text);
  if (restyle) return restyle;

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

function renamePair(target: string, next: string): { target: string; next: string } {
  return {
    target: target.trim(),
    next: next.replace(/\s+instead\b.*$/i, "").trim(),
  };
}

function parseRename(text: string): { target: string; next: string } | null {
  const patterns = [
    /\b(?:change|set|update)\s+(?:the\s+)?(.+?)['’]s\s+name\s+to\s+(.+)$/i,
    /\b(?:change|set|update)\s+(?:the\s+)?name\s+of\s+(?:the\s+)?(.+?)\s+to\s+(.+)$/i,
    /\b(?:rename|relabel)\s+(?:the\s+)?(?:label\s+(?:of\s+)?)?(.+?)\s+(?:to|as|so\s+it\s+reads)\s+(.+)$/i,
    /\bchange\s+(?:the\s+)?label\s+(?:of\s+|on\s+)?(.+?)\s+(?:so\s+it\s+reads|to)\s+(.+)$/i,
    /\bcall\s+(?:the\s+)?(.+?)\s+by\s+the\s+name\s+(.+?)(?:\s+instead)?\s*$/i,
    /\brefer\s+to\s+(?:the\s+)?(.+?)\s+as\s+(.+?)(?:\s+instead)?\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match[2]) return renamePair(match[1], match[2]);
  }
  if (/\bby\s+the\s+name\b/i.test(text) || /\brefer\s+to\b/i.test(text)) return null;
  const called = text.match(/^(?:please\s+)?call\s+(?:the\s+)?(\S+)\s+(\S+)(?:\s+instead)?\s*$/i);
  if (called?.[1] && called[2]) return renamePair(called[1], called[2]);
  return null;
}

function firstClause(value: string): string {
  const cut = value.search(/\.\s+/);
  const sentence = cut === -1 ? value : value.slice(0, cut);
  return sentence.replace(/[?.!]+$/g, "").trim();
}

/** Trailing words that describe the diagram, not a canvas label. */
const ANCHOR_FLUFF = new Set([
  "step",
  "steps",
  "stage",
  "stages",
  "pipeline",
  "pipelines",
  "flow",
  "flows",
  "diagram",
  "diagrams",
  "into",
  "in",
  "on",
  "of",
  "the",
  "this",
  "that",
  "a",
  "an",
  "and",
  "to",
]);

/**
 * Locatives after a new stage name ("into place", "here").
 * "place" stays trailing-only so a name may start with Place ("Place Order").
 * Midpoint and manner words are also stripped from any position via INTERNAL_FLUFF.
 */
const PLACEMENT_FLUFF = new Set(["place", "here", "there", "somewhere", "anywhere", ...PLACEMENT_MANNER_TOKENS]);

/** Words that locate a stage or describe the insert. They are not part of its name, wherever they sit. */
const INTERNAL_FLUFF = new Set([
  "named",
  "called",
  "so",
  "it",
  "its",
  "sits",
  "sit",
  "sitting",
  ...PLACEMENT_MANNER_TOKENS,
]);

function tokenKey(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fluffToken(word: string): boolean {
  return ANCHOR_FLUFF.has(tokenKey(word));
}

function placementToken(word: string): boolean {
  return PLACEMENT_FLUFF.has(tokenKey(word));
}

/** Drop trailing "stages / pipeline / flow / step / of the …" so they are not a new shape. */
function anchorLabel(value: string): string {
  return titleLabel(trimmedWords(value, fluffToken).join(" "));
}

/** Stage name for a between-insert: anchor fluff plus placement words, not a memorized sentence. */
function insertedLabel(value: string, stripVerb = false): string {
  const source = (stripVerb ? value.replace(LEAD_INSERT, "") : value).replace(/[—–]/g, " ");
  const words = trimmedWords(source, (word) => fluffToken(word) || placementToken(word) || internalFluff(word));
  return titleLabel(words.filter((word) => !internalFluff(word)).join(" "));
}

function internalFluff(word: string): boolean {
  return INTERNAL_FLUFF.has(tokenKey(word));
}

const LEAD_INSERT =
  /^(?:please\s+)?(?:add|insert|place|put|drop|splice|wedge|park|stick|tuck|slot|nest)\s+/i;

function trimmedWords(value: string, trailing: (word: string) => boolean): string[] {
  const words = cleanNoun(value).split(/\s+/).filter(Boolean);
  while (words.length > 1 && trailing(words[words.length - 1] ?? "")) words.pop();
  while (words.length > 1 && (fluffToken(words[0] ?? "") || internalFluff(words[0] ?? ""))) words.shift();
  return words;
}

function insertionRest(text: string): string {
  const between = text.match(
    /\b(?:add|insert|place|put|drop|splice|wedge|park|stick|tuck|slot|nest)\b\s+([\s\S]*\bbetween\b[\s\S]*)$/i,
  );
  if (between?.[1]) return between[1];
  return text.replace(/^(?:please\s+)?(?:add|insert|create|draw|place|put|drop|splice|wedge|park|stick|tuck|slot|nest)\s+/i, "");
}

/** "after Build, before Deploy" / "after Build and before Deploy", with the stage name in front. */
function parseAfterBefore(text: string): { label: string; from: string; to: string } | null {
  const patterns = [
    /\bafter\s+(?:the\s+)?(.+?)\s*(?:,|—|–|-)\s*before\s+(?:the\s+)?(.+)$/i,
    /\bafter\s+(?:the\s+)?(.+?)\s+(?:and\s+)?before\s+(?:the\s+)?(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || match.index === undefined || !match[1] || !match[2]) continue;
    const from = anchorLabel(match[1]);
    const to = anchorLabel(match[2]);
    const label = insertedLabel(text.slice(0, match.index), true);
    if (!label || !from || !to) continue;
    if (label.toLowerCase() === from.toLowerCase() || label.toLowerCase() === to.toLowerCase()) continue;
    return { label, from, to };
  }
  return null;
}

function parseAdd(text: string): KevDecision {
  if (!/\bbetween\b/i.test(text)) {
    const positioned = parseAfterBefore(text);
    if (positioned) {
      const slots: DiagramSlots = { ...shapeSlots(positioned.label, text), from: positioned.from, to: positioned.to };
      return decision(
        "add_shape",
        `Added ${positioned.label} between ${positioned.from} and ${positioned.to}.`,
        slots,
        [{ intent: "add_shape", slots }],
      );
    }
  }
  let rest = insertionRest(text);
  rest = rest.replace(/^(?:a|an|the)\s+/i, "");
  rest = firstClause(rest);

  const between = rest.match(/^(.+?)\s+between\s+(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+)$/i);
  if (between?.[1] && between[2] && between[3]) {
    const label = insertedLabel(between[1]);
    const from = anchorLabel(between[2]);
    const to = anchorLabel(between[3]);
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
  const to: string | null = null;

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
  if (overNamedCapacity(message)) {
    return {
      decision: { intent: "clarify", reply: CAPACITY_REPLY, slots: {}, operations: [], updatedXml: null },
      xml,
    };
  }
  const expanded = placeExpansion(message, xml);
  if (expanded) return { decision: expanded.decision, xml: expanded.xml };
  const prepared = hostPreparedComposition(message);
  if (prepared) {
    const placed = composeOnCanvas(message, xml, prepared, renderComposition(prepared));
    if (placed !== "unchanged" && placed !== "keep") return { decision: placed.decision, xml: placed.xml };
  }
  const composed = resolveComposition(message);
  if (composed) {
    const placed = composeOnCanvas(message, xml, composed, renderComposition(composed));
    if (placed === "unchanged") return unchanged(xml);
    if (placed === "keep") return unchanged(xml, KEPT_CANVAS_REPLY);
    return { decision: placed.decision, xml: placed.xml };
  }
  if (unresolvedOpenIdea(message)) {
    return {
      decision: { intent: "clarify", reply: OPEN_IDEA_REPLY, slots: {}, operations: [], updatedXml: null },
      xml,
    };
  }
  const visual = renderBlankArchitecture(message, xml);
  if (visual) return visual;
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
  const grounded = groundDecision(xml, result);
  return { decision: grounded, xml: applyOperations(xml, grounded.operations) };
}
