import { extractNamedEntities, isClauseVerb, listedComponents } from "@/lib/kev/entities";
import { hasEnumeratedBoxes, isBetweenEdit, isCanvasEdit } from "@/lib/kev/plan";

/**
 * Depth of a drawing: a few boxes, or many components and their interactions.
 * The judgment is about the idea. It does not match a prompt keyword.
 */

const PICTURE = /\b(draw|sketch|diagram|show|illustrate|map|build|create|architect)\b/i;
/** "Walk through …" / "Picture a …" / "Trace the …" introduce an idea. The verb is not a box. */
const OPENING =
  /^(?:please\s+)?[a-z][a-z'-]*\s+(?:me\s+)?(?:through|across|over|along|around|about|how|why|where|whether|a|an|the)\b/i;
const INTERACTIONS = /\binteract(?:ing|s|ed|ion|ions)?\b/i;
const GLUE = /^(?:a|an|the|of|and|its|their|his|her|for|with|to|in|on|or)$/i;

export const OPEN_IDEA_REPLY =
  "That idea needs its own components. Name the boxes, or say whether you want a high-level sketch or a detailed diagram.";

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
  if (!PICTURE.test(text) && !OPENING.test(text) && !INTERACTIONS.test(text)) return false;
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
  text = text.replace(
    /^(?:please\s+)?(?:draw|sketch|build|create|architect|show|illustrate|map)\s+(?:me\s+)?(?:a|an|the\s+)?/i,
    "",
  );
  text = text.replace(
    /^(?:please\s+)?[a-z][a-z'-]*\s+(?:me\s+)?(?:through|across|over|along|around|about|how)\s+(?:a|an|the\s+)?/i,
    "",
  );
  text = text.replace(/^(?:please\s+)?(?:picture|trace|follow|describe|explain)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "");
  text = text.replace(/\s+and\s+(?:its|their|his|her)\s+\S+\s*$/i, "");
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
  const nodes: string[] = [];
  const seen = new Set<string>();
  const add = (label: string) => {
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    nodes.push(label);
  };
  for (const link of links) {
    add(link.from);
    add(link.to);
  }
  if (nodes.length < 4) return null;
  const kept = new Set(nodes.slice(0, 8).map((label) => label.toLowerCase()));
  return {
    nodes: nodes.slice(0, 8),
    edges: links.filter((link) => kept.has(link.from.toLowerCase()) && kept.has(link.to.toLowerCase())),
  };
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
  if (/^[A-Z0-9]{2,}$/.test(word)) return word;
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

const REPLACE_CANVAS =
  /\b(?:instead|from scratch|start over|redraw|wipe|clear (?:it|the canvas|this|the diagram))\b/i;

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
const TIER_COUNT = /\b(?:\d+|two|three|four|five)[\s-]*(?:tiers?|layers?)\b/i;

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
