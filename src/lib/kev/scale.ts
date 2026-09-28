import { extractNamedEntities, isClauseVerb, listedComponents } from "@/lib/kev/entities";
import { hasEnumeratedBoxes, isBetweenEdit, isCanvasEdit, opensPicture, parseArchitecture } from "@/lib/kev/plan";

/**
 * Depth of a drawing: a few boxes, or many components and their interactions.
 * The judgment is about the idea. It does not match a prompt keyword.
 */

const PICTURE = /\b(draw|sketch|diagram|show|illustrate|map|build|create|architect)\b/i;
/** A drawing verb at the start, including "lay out" / "arrange" when they introduce a system. */
const PICTURE_LEAD_STRIP =
  /^(?:please\s+)?(?:draw|sketch|build|create|architect|show|illustrate|map|lay\s+out|arrange|organize|organise)\s+(?:me\s+)?(?:a|an|the\s+)?/i;
const TIER_COUNT = /\b(?:\d+|two|three|four|five)[\s-]*(?:tiers?|layers?)\b/i;
/** "Walk through …" / "Picture a …" / "Trace the …" introduce an idea. The verb is not a box. */
const OPENING =
  /^(?:please\s+)?[a-z][a-z'-]*\s+(?:me\s+)?(?:through|across|over|along|around|about|how|why|where|whether|a|an|the)\b/i;
const INTERACTIONS = /\binteract(?:ing|s|ed|ion|ions)?\b/i;
const GLUE = /^(?:a|an|the|of|and|its|their|his|her|for|with|to|in|on|or)$/i;
const REPLACE_CANVAS =
  /\b(?:instead|from scratch|start over|redraw|wipe|clear (?:it|the canvas|this|the diagram))\b/i;

export const OPEN_IDEA_REPLY =
  "That idea needs its own components. Name the boxes, or say whether you want a high-level sketch or a detailed diagram.";

const FRESH_PICTURE = /^(?:please\s+)?(?:draw|sketch|build|create|architect|show|illustrate|map)\b/i;
const DETAILED_ANSWER = /\b(?:detailed|in detail|low[-\s]?level)\b/i;
const HIGH_LEVEL_ANSWER = /\b(?:high[-\s]?level|bird(?:'s)?[-\s]?eye|few boxes|rough sketch)\b/i;
/** Someone is handing the naming job back: “you”, “yourself”, or “for me”. */
const NAMING_DELEGATE = /\b(?:you|yourself|for me)\b/i;
/** The act of choosing labels, not a request to recolor boxes. */
const NAMING_ACT = /\b(?:invent|choose|picks?|supply|decide|name|naming|names|come up with|make up)\b/i;
const NAMING_TARGET = /\b(?:names?|boxes|components?|labels?|parts|nodes|them)\b/i;
const NAMING_IMPERATIVE =
  /^(?:please\s+)?(?:go ahead and\s+)?(?:invent|choose|pick|name)\b/i;

/**
 * A reply to the open-idea question: detailed, high-level, or “you name the boxes”.
 * A fresh picture, a bare draw, or a wipe is not an answer to that question.
 * Detailed wins when both depths are named. High-level wins over a naming delegation.
 * “Invent / pick / give the names” is the same delegation, whatever the wording.
 */
const DEPTH_WORD =
  /^(?:detailed|detail|low(?:-level)?|level|high(?:-level)?|rough|sketch|diagram|it|this|that|one|more|in|very|just|please)$/i;

function delegatesComponentNames(text: string): boolean {
  if (NAMING_DELEGATE.test(text) && NAMING_ACT.test(text) && NAMING_TARGET.test(text)) return true;
  // “You give the names” delegates. “Give the boxes a color” does not.
  if (/\b(?:you|yourself)\b/i.test(text) && /\bgive\b/i.test(text) && /\b(?:names?|labels?)\b/i.test(text)) return true;
  if (NAMING_IMPERATIVE.test(text) && NAMING_TARGET.test(text) && contentWords(text).length <= 8) return true;
  return false;
}

export function depthFromOpenAnswer(message: string): "few" | "many" | null {
  const text = message.trim();
  if (!text || REPLACE_CANVAS.test(text)) return null;
  // "Draw a detailed payment system" is a new picture. "Draw it in detail" is not.
  if (FRESH_PICTURE.test(text) && contentWords(text).some((word) => !DEPTH_WORD.test(word))) return null;
  if (DETAILED_ANSWER.test(text)) return "many";
  if (HIGH_LEVEL_ANSWER.test(text)) return "few";
  if (delegatesComponentNames(text)) return "many";
  return null;
}

/**
 * The previous assistant turn asked for components or depth, and the latest
 * user line answers that question. The idea is the user turn before the ask.
 * Returns null when the latest line is a new picture, a wipe, or anything else.
 */
export function openIdeaDepthFollowUp(
  messages: ReadonlyArray<{ role: string; content: string }>,
): { idea: string; depth: "few" | "many" } | null {
  if (messages.length < 3) return null;
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== "user") return null;
  const depth = depthFromOpenAnswer(latest.content);
  if (!depth) return null;
  let assistantAt = -1;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") return null;
    if (message.role === "assistant") {
      assistantAt = index;
      break;
    }
  }
  if (assistantAt < 0 || messages[assistantAt]?.content.trim() !== OPEN_IDEA_REPLY) return null;
  for (let index = assistantAt - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content.trim()) {
      return { idea: message.content.trim(), depth };
    }
  }
  return null;
}

/**
 * A long picture that named only scraps. Two or three leftovers are not the
 * component list, and a counted tier stack already has its own drawing.
 * A depth answer can continue this idea even when the first turn drew the scraps.
 */
export function sparseOpenPicture(message: string): boolean {
  const text = message.trim();
  if (!text || isCanvasEdit(text) || REPLACE_CANVAS.test(text)) return false;
  if (depthFromOpenAnswer(text) || hasEnumeratedBoxes(text)) return false;
  if (!PICTURE.test(text) && !OPENING.test(text) && !INTERACTIONS.test(text) && !opensPicture(text)) return false;
  if (TIER_COUNT.test(text)) return false;
  if (contentWords(text).length < 8) return false;
  const named = extractNamedEntities(text).filter(
    (entity) => entity.origin !== "adhoc" || text.includes(entity.label),
  );
  if (named.length >= 4) return false;
  const plan = parseArchitecture(text);
  if (plan && plan.nodes.length >= 4) return false;
  return true;
}

/**
 * The latest line chooses depth, and an earlier turn was a sparse picture
 * or a layout-led open ask. The open-idea question is a different continuation.
 * A shape-name miss on a blank page still carries that earlier idea.
 * A depth sentence with no earlier picture is not this.
 */
export function sparseDepthFollowUp(
  messages: ReadonlyArray<{ role: string; content: string }>,
): { idea: string; depth: "few" | "many" } | null {
  if (messages.length < 3) return null;
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== "user") return null;
  const depth = depthFromOpenAnswer(latest.content);
  if (!depth) return null;
  let nearestAssistant: string | null = null;
  let assistantAfterIdea = false;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.content.trim()) continue;
    if (message.role === "assistant") {
      if (nearestAssistant === null) nearestAssistant = message.content.trim();
      assistantAfterIdea = true;
      continue;
    }
    // A layout-led picture ("Lay out a system that …") is the same idea when the
    // assistant asked for a shape name instead of drawing scraps.
    if (message.role === "user" && (sparseOpenPicture(message.content) || opensPicture(message.content))) {
      if (nearestAssistant === OPEN_IDEA_REPLY) return null;
      if (!assistantAfterIdea) return null;
      return { idea: message.content.trim(), depth };
    }
  }
  return null;
}

/**
 * A depth answer continues an earlier idea.
 * `replace` is set when that idea was already drawn as scraps: the depth
 * view takes the page. The open-idea question still draws onto a blank page.
 */
export function depthContinuation(
  messages: ReadonlyArray<{ role: string; content: string }>,
): { idea: string; depth: "few" | "many"; replace: boolean } | null {
  const clarified = openIdeaDepthFollowUp(messages);
  if (clarified) return { ...clarified, replace: false };
  const sparse = sparseDepthFollowUp(messages);
  if (!sparse) return null;
  return { ...sparse, replace: true };
}

export interface BriefLink {
  from: string;
  to: string;
  label: string;
}

/** Words that carry the idea, after the drawing verb and the glue. */
export function contentWords(message: string): string[] {
  const body = message.replace(
    /^(?:please\s+)?(?:draw|sketch|build|create|architect|show|illustrate|map)\s+(?:me\s+)?(?:a|an|the\s+)?/i,
    "",
  );
  return body
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !GLUE.test(word));
}

/**
 * A picture request whose only candidates would be scraps of a longer description.
 * An explicit list, a chain, a counted set of boxes, or two named services is a few-box ask.
 */
export function longUnlistedDescription(message: string): boolean {
  const text = message.trim();
  if (!text || isCanvasEdit(text)) return false;
  if (!PICTURE.test(text) && !OPENING.test(text) && !INTERACTIONS.test(text) && !opensPicture(text)) return false;
  if (hasEnumeratedBoxes(text)) return false;
  // A name the user actually wrote counts. A title-cased scrap of a lowercase phrase does not.
  const named = extractNamedEntities(text).filter(
    (entity) => entity.origin !== "adhoc" || text.includes(entity.label),
  );
  if (named.length >= 2) return false;
  return contentWords(text).length >= 5;
}

/**
 * A short high-level ask with no component list.
 * "Rough overview of a product" is this. A covering-list of named parts is not.
 */
export function highLevelOverview(message: string): boolean {
  const text = message.trim();
  if (!text || isCanvasEdit(text) || hasEnumeratedBoxes(text) || listedComponents(text)) return false;
  const words = contentWords(text);
  if (words.length === 0 || words.length > 12) return false;
  return (
    /\b(?:overview|high[-\s]?level|bird(?:'s)?[-\s]?eye)\b/i.test(text) ||
    /\brough\s+(?:overview|sketch|view|map|diagram|picture|look)\b/i.test(text)
  );
}

/** Subject of an overview, with the framing words removed. Null when this is not an overview. */
export function overviewSubject(message: string): string | null {
  if (!highLevelOverview(message)) return null;
  let text = message.trim();
  text = text.replace(/^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?/i, "");
  text = text.replace(/^(?:give\s+me\s+|show\s+me\s+|i\s+want\s+|i(?:'d| would)\s+like\s+)?/i, "");
  text = text.replace(/^(?:a\s+|an\s+|the\s+)?/i, "");
  text = text.replace(/^(?:rough|quick|brief|simple|short|basic|coarse|high[-\s]?level|detailed)\s+/i, "");
  text = text.replace(/^(?:overview|summary|sketch|view|look|picture|map|diagram)\s+/i, "");
  text = text.replace(/^(?:of\s+)?(?:a\s+|an\s+|the\s+)?/i, "");
  const words = text
    .replace(/[^A-Za-z0-9\s.+_-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !/^(?:a|an|the|of|and|its|their|please)$/i.test(word));
  if (words.length === 0 || words.length > 6) return null;
  return words
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

/** Subject of an open idea, for a high-level box or a topic lookup. */
export function ideaSubject(message: string): string | null {
  let text = message.trim();
  text = text.replace(PICTURE_LEAD_STRIP, "");
  text = text.replace(
    /^(?:please\s+)?[a-z][a-z'-]*\s+(?:me\s+)?(?:through|across|over|along|around|about|how)\s+(?:a|an|the\s+)?/i,
    "",
  );
  text = text.replace(/^(?:please\s+)?(?:picture|trace|follow|describe|explain)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "");
  text = text.replace(/\s+and\s+(?:its|their|his|her)\s+\S+\s*$/i, "");
  text = text.replace(/\s+[—–]\s+[\s\S]*$/, "");
  text = text.replace(/\s+-\s+(?:show|draw|sketch|illustrate|map)\b[\s\S]*$/i, "");
  // A relative or purpose clause is not the subject of the box.
  text = text.replace(/\s+(?:that|which|who|where|when|so)\b[\s\S]*$/i, "");
  text = text.replace(/\b(?:horizontally|horizontal|vertically|vertical|left to right|top to bottom)\b/gi, " ");
  const words = text
    .replace(/[^A-Za-z0-9\s.+_-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !/^(?:a|an|the|and|its|their|his|her|how)$/i.test(word));
  while (words.length > 1 && isClauseVerb(words[0] ?? "")) words.shift();
  while (words.length > 1 && isClauseVerb(words[words.length - 1] ?? "")) words.pop();
  if (words.length === 0) return null;
  const title = words.slice(0, 8).map(displayWord).join(" ");
  if (!/^[A-Za-z0-9]/.test(title)) return null;
  return title.slice(0, 80);
}

const INTERACTION =
  /\b((?:replicates|persists?|writes|publish(?:es)?)\s+to|reads\s+from|calls?|reads?|writes?|sends?|publish(?:es)?|delivers|replicates|loads?|queries|forwards|stores|updates|notifies|returns|fetches|checks|invokes|persists?)\b/i;

/**
 * Components and interactions named inside topic notes.
 * A sentence that says who acts on what becomes an edge. A list after
 * "includes" or "consists of" becomes a chain. Fewer than four components
 * is not a detailed diagram.
 */
export function componentsFromBrief(summary: string): { nodes: string[]; edges: BriefLink[] } | null {
  const sentences = summary
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const links: BriefLink[] = [];
  for (const sentence of sentences) {
    const match = INTERACTION.exec(sentence);
    if (match && match.index !== undefined) {
      const from = clipPhrase(sentence.slice(0, match.index));
      const to = clipPhrase(sentence.slice(match.index + match[0].length));
      if (from && to && from.toLowerCase() !== to.toLowerCase()) {
        links.push({ from, to, label: labelVerb(match[0]) });
        continue;
      }
    }
    const listed = listLinks(sentence);
    if (listed) links.push(...listed);
  }
  const solidLinks = links.filter((link) => solidBriefLabel(link.from) && solidBriefLabel(link.to));
  const solidNodes: string[] = [];
  const solidSeen = new Set<string>();
  for (const link of solidLinks) {
    for (const label of [link.from, link.to]) {
      const key = label.toLowerCase();
      if (solidSeen.has(key)) continue;
      solidSeen.add(key);
      solidNodes.push(label);
    }
  }
  if (solidNodes.length < 4) return null;
  const kept = new Set(solidNodes.slice(0, 8).map((label) => label.toLowerCase()));
  return {
    nodes: solidNodes.slice(0, 8),
    edges: solidLinks.filter((link) => kept.has(link.from.toLowerCase()) && kept.has(link.to.toLowerCase())),
  };
}

/**
 * A topic sentence that matched a verb by accident (“system call”, “it addresses”)
 * is not a component list. Real names from a brief stay.
 */
function solidBriefLabel(label: string): boolean {
  if (!/^[A-Za-z]/.test(label)) return false;
  if (/\b(?:is|are|was|were)\b/i.test(label)) return false;
  if (/^(?:it|this|there|they|which|that)\b/i.test(label)) return false;
  return true;
}

const IDEA_CLAUSE =
  /\s+(that|which|who|where|when|for|using|via|with|through|and|uses|use|so)\s+/i;
/** A finite verb that introduces the next noun, not a name. Local to clause boxes. */
const OPEN_PREDICATE =
  /^(?:batch(?:es|ed|ing)?|stay(?:s|ed|ing)?|saturat(?:e|es|ed|ing)|show(?:s|n|ed|ing)?|keep(?:s|ing)?|remain(?:s|ed|ing)?)$/i;
const LEADING_USE = /^(?:use|uses|using|used)$/i;

/**
 * Components named by splitting the idea on its own clauses.
 * Used only after the user asked for a detailed diagram and topic notes
 * did not name the parts. The clauses are the user's words, not a template.
 */
export function componentsFromOpenIdea(message: string): { nodes: string[]; edges: BriefLink[] } | null {
  const body = ideaRemainder(message);
  if (!body.trim()) return null;
  const pieces = body.split(IDEA_CLAUSE);
  const nodes: string[] = [];
  const edges: BriefLink[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  let marker: string | null = null;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? "";
    if (index % 2 === 1) {
      marker = piece;
      continue;
    }
    const cleaned = cleanIdeaPhrase(piece);
    if (!cleaned) continue;
    const chunks = splitLongPhrase(cleaned.label);
    chunks.forEach((label, chunkIndex) => {
      if (nodes.length >= 8) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      if (previous) {
        const labelFor = chunkIndex === 0 ? (cleaned.verb ?? clauseEdgeLabel(marker)) : "Connects";
        edges.push({ from: previous, to: label, label: labelFor });
      }
      nodes.push(label);
      previous = label;
    });
    marker = null;
    if (nodes.length >= 8) break;
  }
  if (nodes.length < 4) return null;
  const kept = new Set(nodes.map((label) => label.toLowerCase()));
  return {
    nodes,
    edges: edges.filter((link) => kept.has(link.from.toLowerCase()) && kept.has(link.to.toLowerCase())),
  };
}

function ideaRemainder(message: string): string {
  let text = message.trim();
  text = text.replace(PICTURE_LEAD_STRIP, "");
  text = text.replace(
    /^(?:please\s+)?[a-z][a-z'-]*\s+(?:me\s+)?(?:through|across|over|along|around|about|how)\s+(?:a|an|the\s+)?/i,
    "",
  );
  text = text.replace(/^(?:please\s+)?(?:picture|trace|follow|describe|explain)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "");
  text = text.replace(/\s+and\s+(?:its|their|his|her)\s+\S+\s*$/i, "");
  // A dash tail is an instruction ("— show the moving parts"), not another part.
  text = text.replace(/\s+[—–]\s+[\s\S]*$/, "");
  text = text.replace(/\s+-\s+(?:show|draw|sketch|illustrate|map)\b[\s\S]*$/i, "");
  return text;
}

function cleanIdeaPhrase(raw: string): { label: string; verb: string | null } | null {
  const words = raw
    .replace(/[^A-Za-z0-9\s.+_-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let verb: string | null = null;
  while (
    words.length > 0 &&
    (GLUE.test(words[0] ?? "") ||
      isClauseVerb(words[0] ?? "") ||
      LEADING_USE.test(words[0] ?? "") ||
      OPEN_PREDICATE.test(words[0] ?? ""))
  ) {
    if (LEADING_USE.test(words[0] ?? "") || isClauseVerb(words[0] ?? "") || OPEN_PREDICATE.test(words[0] ?? "")) {
      verb = displayWord(words[0] ?? "");
    }
    words.shift();
  }
  const predicateAt = words.findIndex((word, index) => index > 0 && OPEN_PREDICATE.test(word));
  if (predicateAt > 0) words.splice(predicateAt);
  while (words.length > 0 && (GLUE.test(words[words.length - 1] ?? "") || isClauseVerb(words[words.length - 1] ?? ""))) {
    words.pop();
  }
  if (words.length > 8) words.splice(8);
  if (words.length === 0) return null;
  if (words.length === 1 && GENERIC_LABEL.test(words[0] ?? "")) return null;
  if (words.every((word) => /^(?:interactions?|diagrams?|overviews?|sketches?|please)$/i.test(word))) return null;
  const label = words.map(displayWord).join(" ");
  if (label.length < 3 || /^(?:it|this|that|there|they)$/i.test(label)) return null;
  return { label, verb };
}

/** A long clause is several names, not one box. Pairs keep each name readable. */
function splitLongPhrase(label: string): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return [label];
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += 2) {
    const slice = words.slice(index, index + 2);
    if (slice.length === 1 && chunks.length > 0) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${slice[0]}`;
      continue;
    }
    chunks.push(slice.join(" "));
  }
  return chunks;
}

function clauseEdgeLabel(marker: string | null): string {
  const token = (marker ?? "").toLowerCase();
  if (token === "for") return "For";
  if (token === "with") return "With";
  if (token === "via" || token === "through") return "Via";
  if (token === "using" || token === "use" || token === "uses") return "Uses";
  if (token === "so") return "For";
  if (token === "that" || token === "which" || token === "who" || token === "where" || token === "when") return "Includes";
  return "Connects";
}

function listLinks(sentence: string): BriefLink[] | null {
  const match = sentence.match(/\b(?:includes?|contains|consists of|such as)\s+(.+?)[.!?]?$/i);
  if (!match?.[1]) return null;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of match[1].split(/\s*,\s*|\s+\band\b\s+/i)) {
    const name = clipPhrase(part);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length < 2) return null;
  const links: BriefLink[] = [];
  for (let index = 1; index < names.length; index += 1) {
    links.push({ from: names[index - 1]!, to: names[index]!, label: "Includes" });
  }
  return links;
}

function clipPhrase(raw: string): string | null {
  const words = raw
    .replace(/[^A-Za-z0-9\s/+-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 0 && (GLUE.test(words[0] ?? "") || isClauseVerb(words[0] ?? ""))) words.shift();
  while (words.length > 0 && (GLUE.test(words[words.length - 1] ?? "") || isClauseVerb(words[words.length - 1] ?? ""))) {
    words.pop();
  }
  const kept = words.filter((word) => !isClauseVerb(word)).slice(0, 4);
  if (kept.length === 0) return null;
  return kept.map(displayWord).join(" ");
}

function displayWord(word: string): string {
  // "GPU" and "GPUs" stay as written. A normal word is title case.
  if (/^[A-Z0-9]{2,}s?$/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function labelVerb(verb: string): string {
  const text = verb.toLowerCase().replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Words that ask for a richer drawing. A title adjective is included;
 * "simple" / "plain" suppress it unless a scale word is also present.
 * Depth from a reading wins: many grows the drawing, few keeps it short.
 */
const SCALE_TOKENS = new Set([
  "many",
  "multiple",
  "several",
  "numerous",
  "plenty",
  "lots",
  "bunch",
  "dozens",
  "extra",
  "additional",
  "denser",
  "richer",
  "deeper",
  "detailed",
  "complex",
]);

/** Inflections of the same scale words. "Richly" and "dense" are not separate ideas. */
function scaleWord(word: string): boolean {
  const token = word.toLowerCase();
  if (SCALE_TOKENS.has(token)) return true;
  return /^(?:rich(?:ly|er|est|ness)?|dense(?:ly|r|st)?|intricate(?:ly)?|depth|deep(?:er|ly|est)?)$/.test(token);
}

const SCALE_PHRASE =
  /\b(?:more\s+(?:complex|detailed|nodes?|boxes?|shapes?|services?|databases?|caches?|workers?|components?)|in\s+detail)\b/i;

const QUIET_SCALE = /\b(?:simple|basic|plain|minimal|high[-\s]?level|rough)\b/i;

export type DepthReading = "few" | "many" | null;

/** True when the idea should be more than the short default stack. */
export function wantsRicherDiagram(message: string, depth?: DepthReading): boolean {
  if (depth === "few") return false;
  if (depth === "many") return true;
  const text = message.trim();
  if (!text || REPLACE_CANVAS.test(text)) return false;
  const tokens = new Set(contentWords(text).map((word) => word.toLowerCase()));
  const tokenHit = [...tokens].some((word) => scaleWord(word));
  const phrase = SCALE_PHRASE.test(text);
  if (QUIET_SCALE.test(text) && !tokenHit && !phrase) return false;
  return tokenHit || phrase;
}

const PICTURE_LEAD = /^(?:please\s+)?(?:draw|sketch|build|create|architect|show|illustrate|map)\b/i;

/**
 * A follow-up that asks to grow the open diagram.
 * A draw-led N-tier sentence is a first picture, not this.
 * Replacing the canvas (instead, from scratch, wipe) is not this.
 */
export function isExpandFollowUp(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || REPLACE_CANVAS.test(trimmed) || isBetweenEdit(trimmed)) return false;
  const complaint =
    /\b(?:i asked|asked for|not enough|too (?:few|simple|sparse|small)|make (?:it|this|the diagram|the stack|that) (?:more )?(?:complex|detailed|dense|rich)|more complex|more detailed)\b/i.test(
      trimmed,
    );
  const quantity =
    /\b(?:many|multiple|several|lots|bunch|extra|additional|denser|richer|deeper)\b/i.test(trimmed) &&
    /\b(?:nodes?|boxes?|shapes?|services?|databases?|caches?|workers?|components?|detail|diagram|stack)\b/i.test(trimmed);
  const moreOf =
    /\b(?:more|extra|additional)\s+(?:\w+\s+){0,2}(?:nodes?|boxes?|shapes?|services?|databases?|caches?|workers?|queues?|stores?)\b/i.test(
      trimmed,
    );
  if (!complaint && !quantity && !moreOf) return false;
  if (PICTURE_LEAD.test(trimmed) && TIER_COUNT.test(trimmed) && !/\b(?:i asked|asked for|not enough|too few)\b/i.test(trimmed)) {
    return false;
  }
  return true;
}

export type PluralRole = "database" | "cache" | "worker" | "service" | "queue" | "storage";

const PLURAL_ROLES: Array<{ role: PluralRole; pattern: RegExp }> = [
  // A specific role beside a collective ("database stores") wins over the collective itself.
  {
    role: "database",
    pattern: /\b(?:databases|dbs)\b|\b(?:database|db|data)\s+(?:stores?|nodes|boxes|instances)\b/i,
  },
  { role: "cache", pattern: /\bcaches\b|\bcache\s+(?:stores?|nodes|boxes|instances)\b/i },
  { role: "worker", pattern: /\bworkers\b|\bworker\s+(?:nodes|boxes|instances|pool)\b/i },
  { role: "service", pattern: /\bservices\b|\bservice\s+(?:nodes|boxes|instances)\b/i },
  { role: "queue", pattern: /\bqueues\b|\bqueue\s+(?:stores?|nodes|boxes|instances)\b/i },
  { role: "storage", pattern: /\bstores\b/i },
];

const GENERIC_LABEL =
  /^(?:databases?|dbs?|caches?|workers?|services?|queues?|stores?|nodes?|boxes?|shapes?|components?|tiers?|layers?|systems?|apps?|applications?|instances?|pools?|many|more|extra|additional|several|multiple|lots|some|new|other|another|please|add|ok|okay|but|asked|just|too|few|complex|detailed|dense|rich|richer)$/i;

/**
 * Scaffolding around a role: the request verb, a modal, a quantifier, or where to put it.
 * "Add" was already generic. "Drop" and "Could" were minted as boxes and hid the role.
 */
const REQUEST_SCRAP =
  /^(?:add|insert|place|put|drop|splice|wedge|park|stick|tuck|slot|nest|draw|sketch|build|create|architect|could|would|should|can|may|might|please|just|kindly|onto|into|upon|on|board|canvas|diagram|page|sheet|here|there|handful|couple|various|assorted|pair|bunch|number)$/i;

function serviceWord(word: string): boolean {
  return !GENERIC_LABEL.test(word) && !REQUEST_SCRAP.test(word);
}

/** A catalog or coined product. A leading verb or a locative is not one. */
function hasProperService(message: string): boolean {
  return extractNamedEntities(message).some((entity) => entity.label.split(/\s+/).some((word) => serviceWord(word)));
}

/** The sentence is asking to place a role, not mentioning one inside a longer idea. */
const ROLE_PLACEMENT =
  /^(?:please\s+)?(?:(?:could|would|can|will)\s+you\s+)?(?:please\s+|also\s+|just\s+)?(?:add|insert|place|put|drop|splice|wedge|park|stick|tuck|slot|nest|include|attach)\b/i;

/**
 * A plural role with no proper name ("databases", "caches", "workers").
 * A named product beside the role is the user's label, not this.
 * A collective takes the more specific role in front of it ("database stores").
 */
export function pluralRoleOf(message: string): PluralRole | null {
  const text = message.trim();
  if (!text || REPLACE_CANVAS.test(text) || isBetweenEdit(text)) return null;
  // A long idea may mention workers or services in passing. That is not "add workers".
  // A placement sentence that says "diagram" is still this request.
  if (longUnlistedDescription(text) && !ROLE_PLACEMENT.test(text)) return null;
  const hit = PLURAL_ROLES.find((item) => item.pattern.test(text));
  if (!hit) return null;
  if (hasProperService(text)) return null;
  return hit.role;
}
