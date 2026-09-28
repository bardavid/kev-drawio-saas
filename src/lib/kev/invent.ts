import type { ShapeKind } from "@/lib/drawio/styles";
import type { EntityRole } from "@/lib/kev/entities";
import { isClauseVerb } from "@/lib/kev/entities";
import { ideaSubject } from "@/lib/kev/scale";

/**
 * A detailed open idea whose boxes were not named.
 * The host invents roles from the idea's own words: who calls in, the front
 * door, control, the workers, and each thing named on the path.
 * A purpose, a manner compound, an absence, or an adjective and abstract
 * property is a quality of an edge, not a box. A leftover clause is not a box.
 * The same rules apply to every idea.
 */

export interface InventedNode {
  label: string;
  role: EntityRole;
  shape: ShapeKind;
  group: string;
}

export interface InventedArchitecture {
  title: string;
  nodes: InventedNode[];
  edges: Array<{ from: string; to: string; label: string }>;
}

interface Draft extends InventedNode {
  rank: number;
  order: number;
}

const GLUE = /^(?:a|an|the|of|and|its|their|his|her|for|with|to|in|on|or|from|across)$/i;
const FILLER =
  /^(?:shared|sealed|stale|common|dedicated|simple|basic|internal|external|temporary|local|remote|single|regional|distributed|multi|general|purpose)$/i;
const LEADING_VERB =
  /^(?:hop|hops|hopping|swing|swings|batch|batches|serve|serves|fan|fans|send|sends|route|routes|move|moves|carry|carries|haul|hauls|ship|ships|pass|passes|flow|flows|run|runs|call|calls|read|reads|write|writes|use|uses|using|store|stores|pull|pulls|keep|keeps)$/i;
const OUTCOME_PREDICATE = /^(?:stay|stays|stayed|remain|remains|saturate|saturates|saturated|keep|keeps|cool|cools)$/i;
const GENERIC_PHRASE =
  /^(?:interactions?|requests?|alerts?|data|transfer|parts?|signals?|traffic|work|loads?|pulls?|items?|things?|regions?|region|overview|diagram|sketches?)$/i;
const GENERIC_WORD =
  /^(?:interactions?|requests?|alerts?|data|transfer|parts?|signals?|traffic|work|loads?|pulls?|items?|things?|regions?|region|overview|diagram|sketches?)$/i;
const TAIL =
  /^(?:system|platform|service|application|app|network|cluster|subsystem|distributed|multi|edge|yard|farm|general|purpose|mesh)$/i;
const SPREAD = /\b(?:distributed|multi|mesh|regional|replicated|replication|cluster|sharded|peers?)\b/i;
const ROLE_STOP = new Set(["node", "service", "worker", "path", "transport", "system", "group", "cluster", "queue"]);
const ROLE_NOUN =
  /\b(?:caches?|stores?|storages?|locks?|rings?|lines?|queues?|busses|buses|buffers?|memories|memory|disks?|origins?|brokers?|indexes|indices|index|gateways?|routers?|schedulers?|engines?|workers?|pops?|sheds?|docks?|crates?|manifests?|journals?|replicas?|peers?|nodes?|paths?)\b/i;

const CLAUSE =
  /\s+(that|which|who|where|when|for|using|via|with|through|and|uses|use|so|from)\s+/i;

function isMannerCompound(text: string): boolean {
  return /[a-z0-9]+-(?:while|and|or|to|of)-[a-z0-9]+/i.test(text) || /^(?:at|best|exactly)-/i.test(text);
}

function isDeverbal(word: string): boolean {
  return /(?:tion|sion|ment|ness|ance|ence|ing|ies)$/i.test(word) && !ROLE_NOUN.test(word);
}

/** Degree, absence, or pace. “Zero copy” and “low latency” are properties, not parts. */
const DEGREE = /^(?:low|high|zero|no|non|fast|slow|even|full|half|extra|ultra|very|more|less|soft|hard|hot|cold|quiet|cool|steady|stable|secure|safe|fresh)$/i;
/** A generic name for the path itself. It is not a part beside the quality. */
const MANNER_NOUN = /^(?:paths?|transports?|flows?|routes?|ways?|channels?|conduits?)$/i;

function isAdjectiveForm(word: string): boolean {
  if (ROLE_NOUN.test(word)) return false;
  return /(?:ed|ing|al|ive|ous|ic|less|ful|able|ible|ary|ency|ity|ness|ance|ence)$/i.test(word);
}

/** An abstract noun (metry, graphy, logy). A concrete part is not one. */
function isAbstractNoun(word: string): boolean {
  if (ROLE_NOUN.test(word)) return false;
  return /(?:metry|graphy|logy|nomy|scopy|osis|ism)$/i.test(word);
}

function qualityWords(raw: string): string[] {
  return tokenize(raw).filter(
    (word) => !GLUE.test(word) && !FILLER.test(word) && !LEADING_VERB.test(word) && !isClauseVerb(word) && !MANNER_NOUN.test(word),
  );
}

function isQualityWord(word: string): boolean {
  return DEGREE.test(word) || isAdjectiveForm(word) || isDeverbal(word) || isAbstractNoun(word) || GENERIC_WORD.test(word);
}

/** A leading adjective, degree, or deverbal. “Encrypted beacon” starts with one. A bare part does not. */
function isModifier(word: string): boolean {
  return DEGREE.test(word) || isAdjectiveForm(word) || isDeverbal(word);
}

/**
 * A property of how something moves, not a part you can draw as a peer box.
 * Hyphenated manner, an absence (“zero …”), or an adjective plus an abstract noun.
 * A trailing path, route, or channel is the manner, not a vertex.
 * Two bare nouns stay parts. A single bare noun stays a part.
 */
function isQualityPhrase(raw: string): boolean {
  if (isMannerCompound(raw)) return true;
  const parts = raw.split(/[-\s]+/).filter((part) => part && !MANNER_NOUN.test(part));
  if (raw.includes("-") && parts.length >= 2 && parts.every((part) => !ROLE_NOUN.test(part))) return true;
  const words = qualityWords(raw);
  if (words.length === 0) return false;
  if (words.some((word) => ROLE_NOUN.test(word))) return false;
  if (/^(?:zero|no|non)$/i.test(words[0] ?? "") && words.slice(1).every((word) => !ROLE_NOUN.test(word))) return true;
  if (words.every((word) => isQualityWord(word))) return true;
  // “Veiled signal path” is a property. “Stone piers” and “haul drum” are things.
  const head = words[0] ?? "";
  return words.length >= 2 && isModifier(head) && words.slice(1).every((word) => !ROLE_NOUN.test(word));
}

/**
 * A phrase that must not be a box: a leading preposition, a manner compound,
 * or a property of the path. A named thing is not a scrap.
 */
export function isScrapLabel(label: string): boolean {
  const text = label.trim();
  if (text.length < 2) return true;
  if (/^(?:from|to|into|onto|via|with|using|for|and)\b/i.test(text)) return true;
  if (isMannerCompound(text) || isQualityPhrase(text)) return true;
  const words = tokenize(text).filter((word) => !GLUE.test(word));
  if (words.length === 0) return true;
  // “Operators see steady …” is a leftover clause, not a part.
  if (words.some((word) => isClauseVerb(word) || OUTCOME_PREDICATE.test(word))) return true;
  if (words.some((word) => ROLE_NOUN.test(word) && !MANNER_NOUN.test(word))) return false;
  return words.every((word) => FILLER.test(word) || isDeverbal(word) || isAbstractNoun(word) || GENERIC_WORD.test(word) || MANNER_NOUN.test(word));
}

function displayWord(word: string): string {
  if (/^[A-Z0-9]{2,}s?$/.test(word)) return word;
  if (word.includes("-")) {
    return word
      .split("-")
      .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
      .join("-");
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function tokenize(raw: string): string[] {
  return raw
    .replace(/[^A-Za-z0-9\s.+_-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function cleanPhrase(raw: string): string | null {
  const words = tokenize(raw);
  while (
    words.length > 0 &&
    (GLUE.test(words[0] ?? "") || FILLER.test(words[0] ?? "") || LEADING_VERB.test(words[0] ?? "") || isClauseVerb(words[0] ?? ""))
  ) {
    words.shift();
  }
  while (
    words.length > 0 &&
    (GLUE.test(words[words.length - 1] ?? "") ||
      FILLER.test(words[words.length - 1] ?? "") ||
      isClauseVerb(words[words.length - 1] ?? "") ||
      OUTCOME_PREDICATE.test(words[words.length - 1] ?? ""))
  ) {
    words.pop();
  }
  const kept = words.filter((word) => !FILLER.test(word) && !GENERIC_WORD.test(word));
  if (kept.length === 0 || kept.length > 4) return null;
  const label = kept.map(displayWord).join(" ");
  if (label.length < 2 || GENERIC_PHRASE.test(label) || isScrapLabel(label)) return null;
  return label;
}

function hasRoleNoun(raw: string): boolean {
  return ROLE_NOUN.test(raw);
}

function qualityText(raw: string): string | null {
  if (isMannerCompound(raw)) {
    const token = tokenize(raw).find((word) => word.includes("-"));
    return token ? displayWord(token) : null;
  }
  const words = qualityWords(raw);
  if (words.length === 0) return null;
  const label = words.slice(0, 4).map(displayWord).join(" ");
  if (label.length < 2 || GENERIC_PHRASE.test(label)) return null;
  return label;
}

function isWithAttribute(raw: string): boolean {
  return isQualityPhrase(raw);
}

function remainder(message: string): string {
  let text = message.trim();
  text = text.replace(
    /^(?:please\s+)?(?:draw|sketch|build|create|architect|show|illustrate|map|lay\s+out|arrange|organize|organise)\s+(?:me\s+)?(?:a|an|the\s+)?/i,
    "",
  );
  text = text.replace(
    /^(?:please\s+)?[a-z][a-z'-]*\s+(?:me\s+)?(?:through|across|over|along|around|about|how)\s+(?:a|an|the\s+)?/i,
    "",
  );
  text = text.replace(/^(?:please\s+)?(?:picture|trace|follow|describe|explain)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "");
  text = text.replace(/\s+and\s+(?:its|their|his|her)\s+\S+\s*$/i, "");
  text = text.replace(/\s+[—–]\s+[\s\S]*$/, "");
  text = text.replace(/\s+-\s+(?:show|draw|sketch|illustrate|map)\b[\s\S]*$/i, "");
  return text;
}

interface Parsed {
  mechanisms: string[];
  sources: string[];
  qualities: string[];
  outcome: string | null;
}

function namesFrom(part: string): string[] {
  const labels: string[] = [];
  for (const piece of part.split(/\s*,\s*|\s+\band\b\s+/i)) {
    const label = cleanPhrase(piece);
    if (label) labels.push(label);
  }
  return labels;
}

function outcomeNoun(part: string): string | null {
  const words = tokenize(part).filter((word) => !GLUE.test(word) && !FILLER.test(word) && !GENERIC_WORD.test(word));
  const cut = words.findIndex((word, index) => index > 0 && OUTCOME_PREDICATE.test(word));
  const kept = cut > 0 ? words.slice(0, cut) : words.filter((word) => !OUTCOME_PREDICATE.test(word) && !LEADING_VERB.test(word));
  if (kept.length === 0) return null;
  const label = kept.slice(0, 3).map(displayWord).join(" ");
  if (GENERIC_PHRASE.test(label) || isScrapLabel(label)) return null;
  return label;
}

type Slot = "subject" | "mechanism" | "manner" | "with" | "source" | "purpose" | "outcome";

function peelMarker(piece: string): { marker: string; rest: string } | null {
  const match = piece.match(/^\s*(that|which|who|where|when|for|using|via|with|through|and|uses|use|so|from)\b\s*/i);
  if (!match?.[1]) return null;
  return { marker: match[1].toLowerCase(), rest: piece.slice(match[0].length) };
}

function slotFor(marker: string, current: Slot): Slot {
  if (marker === "and") return current === "subject" ? "manner" : current;
  if (marker === "for") return "purpose";
  if (marker === "so") return "outcome";
  if (marker === "from") return "source";
  if (marker === "with") return "with";
  if (/^(?:uses?|using|via|through)$/.test(marker)) return "mechanism";
  return "manner";
}

function takeThing(parsed: Parsed, piece: string) {
  if (isQualityPhrase(piece)) {
    const quality = qualityText(piece);
    if (quality) parsed.qualities.push(quality);
    return;
  }
  if (!hasRoleNoun(piece)) {
    const label = cleanPhrase(piece);
    if (!label) return;
    parsed.mechanisms.push(label);
    return;
  }
  parsed.mechanisms.push(...namesFrom(piece));
}

function takePiece(parsed: Parsed, slot: Slot, piece: string) {
  if (slot === "purpose") {
    const quality = qualityText(piece);
    if (quality) parsed.qualities.push(quality);
    return;
  }
  if (slot === "with") {
    if (isWithAttribute(piece)) {
      const quality = qualityText(piece);
      if (quality) parsed.qualities.push(quality);
      return;
    }
    takeThing(parsed, piece);
    return;
  }
  if (slot === "manner") {
    if (isQualityPhrase(piece) || hasRoleNoun(piece)) takeThing(parsed, piece);
    return;
  }
  if (slot === "mechanism") takeThing(parsed, piece);
  else if (slot === "source") parsed.sources.push(...namesFrom(piece));
  else if (slot === "outcome") parsed.outcome = outcomeNoun(piece);
}

function parseClauses(body: string): Parsed {
  const pieces = body.split(CLAUSE);
  const parsed: Parsed = { mechanisms: [], sources: [], qualities: [], outcome: null };
  let slot: Slot = "subject";
  for (let index = 0; index < pieces.length; index += 1) {
    let piece = pieces[index] ?? "";
    if (index % 2 === 1) {
      slot = slotFor(piece.toLowerCase(), slot);
      continue;
    }
    let peeled = peelMarker(piece);
    while (peeled) {
      slot = slotFor(peeled.marker, slot);
      piece = peeled.rest;
      peeled = peelMarker(piece);
    }
    if (slot === "subject" || !piece.trim()) continue;
    takePiece(parsed, slot, piece);
  }
  return parsed;
}

function workerLabel(title: string): string {
  const words = title.split(/[\s-]+/).filter((word) => word && !TAIL.test(word));
  const core = words.join(" ") || title;
  if (/\b(?:nodes?|workers?)$/i.test(core)) return core;
  return `${core} Nodes`;
}

function draft(label: string, role: EntityRole, shape: ShapeKind, group: string, rank: number, order: number): Draft {
  return { label, role, shape, group, rank, order };
}

function tokenSet(label: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of label.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2) continue;
    const stem = raw.endsWith("s") && raw.length > 3 ? raw.slice(0, -1) : raw;
    if (ROLE_STOP.has(stem) || ROLE_STOP.has(raw)) continue;
    tokens.add(stem);
  }
  return tokens;
}

function overlaps(left: string, right: string): boolean {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return left.toLowerCase() === right.toLowerCase();
  for (const token of a) if (b.has(token)) return true;
  return false;
}

function prefer(current: Draft, incoming: Draft): Draft {
  const currentSpecific = tokenSet(current.label).size;
  const incomingSpecific = tokenSet(incoming.label).size;
  const base = incomingSpecific > currentSpecific ? incoming : current;
  return {
    ...base,
    label: incomingSpecific > currentSpecific ? incoming.label : current.label,
    rank: Math.min(current.rank, incoming.rank),
    order: Math.min(current.order, incoming.order),
  };
}

function absorb(nodes: Draft[], incoming: Draft) {
  if (isScrapLabel(incoming.label)) return;
  const hit = nodes.findIndex((node) => overlaps(node.label, incoming.label));
  if (hit < 0) {
    nodes.push(incoming);
    return;
  }
  nodes[hit] = prefer(nodes[hit]!, incoming);
}

function phraseNode(label: string, order: number): Draft {
  const text = label.toLowerCase();
  if (/\b(?:caches?|indexes|indices|index|journals?|buffers?|memories|memory)\b/.test(text)) {
    return draft(label, "data", "cylinder", "Data", 3, order);
  }
  if (/\b(?:stores?|storages?|disks?|volumes?|chunks?)\b/.test(text)) {
    return draft(label, "storage", "cloud", "Storage", 6, order);
  }
  if (/\borigins?\b/.test(text)) return draft("Origin", "storage", "cloud", "Origin", 4, order);
  if (/\b(?:queues?|rings?|busses|buses|brokers?)\b/.test(text)) {
    return draft(label, "bus", /\bqueues?\b/.test(text) ? "queue" : "hexagon", "Path", 3, order);
  }
  if (/\brouters?\b/.test(text)) return draft(label, "bus", "hexagon", "Path", 3, order);
  if (/\b(?:gateways?|pops?|ingress)\b/.test(text)) return draft(label, "edge", "hexagon", "Edge", 3, order);
  if (/\bmanifests?\b/.test(text)) return draft(label, "compute", "document", "Control", 3, order);
  return draft(label, "compute", "rectangle", "Parts", 3, order);
}

/** A thing with no part-word of its own is a path. The words stay the user's. */
function expandMechanism(label: string, order: number): Draft {
  if (ROLE_NOUN.test(label)) return phraseNode(label, order);
  if (/\bpaths?$/i.test(label)) return draft(label, "bus", "hexagon", "Path", 3, order);
  return draft(`${label} Path`, "bus", "hexagon", "Path", 3, order);
}

function relationLabel(from: Draft, to: Draft): string {
  if (to.group === "Peers") return "Sync";
  if (to.group === "Origin" || /^origin$/i.test(to.label)) return "Fetch";
  if (from.role === "client") return "Request";
  if (/coordinator/i.test(to.label)) return "Direct";
  if (to.group === "Path" || to.group === "Parts" || to.group === "Data") return "Through";
  if (to.group === "Outcomes") return "Reach";
  return "Call";
}

const GENERIC_RELATION = /^(?:Request|Direct|Call|Reach|Sync|Fetch|Through)$/;

function assignEdges(ordered: Draft[], qualities: string[]): InventedArchitecture["edges"] {
  const edges: InventedArchitecture["edges"] = [];
  let cursor = 0;
  const take = () => {
    const quality = qualities[cursor];
    if (!quality) return null;
    cursor += 1;
    return quality;
  };
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1]!;
    const to = ordered[index]!;
    const group = to.group;
    const preferred = group === "Path" || group === "Parts" || group === "Data";
    const quality = preferred ? take() : null;
    edges.push({ from: from.label, to: to.label, label: quality || relationLabel(from, to) });
  }
  const placeLeftover = (index: number) => {
    const edge = edges[index];
    const quality = qualities[cursor];
    if (!edge || !quality || !GENERIC_RELATION.test(edge.label)) return false;
    edge.label = quality;
    cursor += 1;
    return true;
  };
  const worker = ordered.findIndex((node) => node.group === "Workers");
  if (worker > 0) placeLeftover(worker - 1);
  for (let index = 0; index < edges.length && cursor < qualities.length; index += 1) placeLeftover(index);
  return edges;
}

/**
 * Roles for one open idea. Null when the idea has no subject.
 * At least four boxes, with a labeled edge between neighbors.
 */
export function architectureFromIdea(message: string): InventedArchitecture | null {
  const title = ideaSubject(message);
  if (!title) return null;
  const parsed = parseClauses(remainder(message));
  const nodes: Draft[] = [];
  let order = 0;
  const add = (label: string, role: EntityRole, shape: ShapeKind, group: string, rank: number) => {
    order += 1;
    absorb(nodes, draft(label, role, shape, group, rank, order));
  };
  add("Clients", "client", "rectangle", "Clients", 0);
  add("Gateway", "edge", "hexagon", "Edge", 1);
  add("Coordinator", "compute", "rectangle", "Control", 2);
  add(workerLabel(title), "compute", "rectangle", "Workers", 5);

  parsed.mechanisms.forEach((label, index) => {
    absorb(nodes, expandMechanism(label, 100 + index));
  });
  parsed.sources.forEach((label, index) => {
    const name = /\borigins?\b/i.test(label) ? "Origin" : label;
    absorb(nodes, draft(name, "storage", "cloud", "Origin", 4, 300 + index));
  });
  if (parsed.outcome) absorb(nodes, draft(parsed.outcome, "compute", "rectangle", "Outcomes", 7, 400));
  if (SPREAD.test(message) && !nodes.some((node) => /\bpeers?\b/i.test(node.label))) {
    absorb(nodes, draft("Peers", "compute", "rectangle", "Peers", 6, 450));
  }

  const ordered = [...nodes].sort((left, right) => left.rank - right.rank || left.order - right.order).slice(0, 8);
  if (ordered.length < 4) return null;
  return {
    title,
    nodes: ordered.map(({ label, role, shape, group }) => ({ label, role, shape, group })),
    edges: assignEdges(ordered, parsed.qualities),
  };
}
