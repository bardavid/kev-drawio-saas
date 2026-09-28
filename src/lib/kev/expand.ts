import type { ShapeKind } from "@/lib/drawio/styles";
import { extractNamedEntities, rolePaint, type EntityRole, type NamedEntity } from "@/lib/kev/entities";
import { requestedLayout } from "@/lib/kev/plan";
import { isInteractionAsk } from "@/lib/kev/system-ask";

/**
 * Underspecified subsystem, interaction, and "how it works" asks.
 * The host expands the topic into a layered architecture. It does not
 * tokenize adjective-noun scraps ("general purpose", "storage") into vertices.
 * Motifs are system types, not prompt strings. An unknown topic still expands.
 */

export interface OpenNode {
  id: string;
  label: string;
  shape: ShapeKind;
  fill: string;
  stroke: string;
}

export interface OpenGroup {
  id: string;
  label: string;
  nodes: OpenNode[];
}

export interface OpenEdge {
  from: string;
  to: string;
  label: string;
  side?: boolean;
}

export interface OpenSystem {
  title: string;
  reply: string;
  context: string;
  researchTopic: string | null;
  axis?: "horizontal";
  groups: OpenGroup[];
  edges: OpenEdge[];
}

interface Piece {
  id: string;
  label: string;
  role: EntityRole;
  shape?: ShapeKind;
  group: string;
}

interface Blueprint {
  rank: number;
  when: RegExp;
  title: string;
  wiki: string;
  context: string;
  pieces: Piece[];
  links: string[];
  extra?: OpenEdge[];
}

const TIER_ASK = /\b(\d+|two|three|four|five)[\s-]*(?:tiers?|layers?)\b/i;
const CLOSED_KIND = /\b(sequences?|flowcharts?|workflows?|state\s+machines?|choreograph\w*|pipelines?)\b/i;

const MODIFIER_HEAD = new Set([
  "general",
  "distributed",
  "managed",
  "simple",
  "basic",
  "generic",
  "scalable",
  "durable",
  "primary",
  "internal",
  "external",
  "shared",
  "dedicated",
  "global",
  "elastic",
  "serverless",
  "automatic",
  "regional",
]);

/** Words that describe the ask. They are not a service the user listed. */
const NOT_A_COMPONENT = new Set([
  "general",
  "purpose",
  "storage",
  "caching",
  "cache",
  "cached",
  "interaction",
  "interactions",
  "subsystem",
  "subsystems",
  "system",
  "systems",
  "architecture",
  "architectures",
  "diagram",
  "diagrams",
  "internal",
  "internals",
  "kv",
  "key",
  "value",
  "values",
  "key-value",
  "simple",
  "basic",
  "generic",
  "modern",
  "component",
  "components",
]);

const TOPIC_DROP = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "its",
  "their",
  "with",
  "for",
  "to",
  "in",
  "on",
  "please",
  "me",
  "draw",
  "sketch",
  "show",
  "illustrate",
  "map",
  "build",
  "create",
  "architect",
  "diagram",
  "diagrams",
  "subsystem",
  "subsystems",
  "sub-system",
  "system",
  "systems",
  "architecture",
  "architectures",
  "interaction",
  "interactions",
  "internal",
  "internals",
  "component",
  "components",
  "how",
  "does",
  "do",
  "works",
  "work",
  "working",
  "between",
  "within",
  "inside",
  "just",
]);

const LEADING = new Set([
  "general",
  "purpose",
  "generic",
  "simple",
  "basic",
  "modern",
  "distributed",
  "scalable",
  "durable",
  "internal",
  "external",
  "primary",
]);

const TRAILING = new Set(["service", "services", "system", "systems", "subsystem", "layer", "layers"]);

const CACHE: Blueprint = {
  rank: 80,
  when: /\b(kv|key[-\s]?values?|memcached?|caching|caches|cache)\b/i,
  title: "KV cache",
  wiki: "Cache (computing)",
  context:
    "A general-purpose key-value cache sits in front of a backing store. Clients call a cache API, which looks up a cache tier addressed by a key index. Entries expire by eviction and TTL. Replicas copy hot keys. A miss reads the backing store and fills the cache.",
  pieces: [
    { id: "clients", label: "Clients", role: "client", group: "Clients" },
    { id: "api", label: "Cache API", role: "edge", shape: "hexagon", group: "Edge" },
    { id: "tier", label: "Cache tier", role: "data", shape: "cylinder", group: "Cache" },
    { id: "index", label: "Key index", role: "compute", group: "Cache" },
    { id: "ttl", label: "Eviction / TTL", role: "compute", group: "Cache" },
    { id: "replica", label: "Replication", role: "compute", group: "Cache" },
    { id: "backing", label: "Backing store", role: "storage", shape: "cloud", group: "Storage" },
  ],
  links: ["Request", "Lookup", "Address", "Expire", "Replicate", "Write-behind"],
  extra: [
    { from: "api", to: "backing", label: "Read on miss", side: true },
    { from: "backing", to: "tier", label: "Fill", side: true },
  ],
};

const MESSAGING: Blueprint = {
  rank: 70,
  when: /\b(message\s+queues?|queueing|queuing|messagings?|message\s+brokers?|pub[\s/-]?sub|event\s+bus(?:es)?)\b/i,
  title: "Message queue",
  wiki: "Message queue",
  context:
    "A message queue decouples producers from consumers. Producers publish through an ingress into a broker, which appends a topic log. Consumers take deliveries and acknowledge them. Retention bounds the log. Poison messages land on a dead-letter queue.",
  pieces: [
    { id: "producers", label: "Producers", role: "client", group: "Clients" },
    { id: "ingress", label: "Ingress", role: "edge", shape: "hexagon", group: "Edge" },
    { id: "broker", label: "Broker", role: "bus", shape: "queue", group: "Bus" },
    { id: "log", label: "Topic log", role: "bus", group: "Bus" },
    { id: "consumers", label: "Consumers", role: "compute", group: "Services" },
    { id: "ack", label: "Acknowledgements", role: "compute", group: "Control" },
    { id: "retention", label: "Retention", role: "compute", group: "Control" },
    { id: "dlq", label: "Dead-letter queue", role: "bus", shape: "queue", group: "Failures" },
  ],
  links: ["Publish", "Enqueue", "Append", "Deliver", "Ack", "Retain", "Expire"],
  extra: [{ from: "broker", to: "dlq", label: "Poison", side: true }],
};

const AUTH: Blueprint = {
  rank: 70,
  when: /\b(authenticat(?:e|ion|ing)|authoriz(?:e|ation|ing)|identity\s+providers?|sign[\s-]?in)\b/i,
  title: "Authentication",
  wiki: "Authentication",
  context:
    "Authentication checks a caller, issues a token, and remembers the session. Clients sign in at a login endpoint. An identity provider verifies them and a token issuer grants a credential. The session store holds it. A resource server authorizes the call and writes an audit log.",
  pieces: [
    { id: "clients", label: "Clients", role: "client", group: "Clients" },
    { id: "login", label: "Login endpoint", role: "edge", shape: "hexagon", group: "Edge" },
    { id: "idp", label: "Identity provider", role: "compute", group: "Identity" },
    { id: "tokens", label: "Token issuer", role: "compute", group: "Identity" },
    { id: "session", label: "Session store", role: "data", shape: "cylinder", group: "Session" },
    { id: "resource", label: "Resource server", role: "compute", group: "Resources" },
    { id: "audit", label: "Audit log", role: "storage", shape: "document", group: "Audit" },
  ],
  links: ["Sign in", "Verify", "Issue", "Save", "Authorize", "Record"],
  extra: [{ from: "tokens", to: "resource", label: "Bearer", side: true }],
};

const STORAGE: Blueprint = {
  rank: 40,
  when: /\b(object\s+storage|blob\s+storage|block\s+storage|file\s*systems?|filesystems?|storage)\b/i,
  title: "Storage subsystem",
  wiki: "Object storage",
  context:
    "A storage subsystem keeps bytes behind an API. Clients call the storage API, which consults metadata, places the object on data nodes, and replicates it. A durability log records the write. A direct get can skip metadata.",
  pieces: [
    { id: "clients", label: "Clients", role: "client", group: "Clients" },
    { id: "api", label: "Storage API", role: "edge", shape: "hexagon", group: "Edge" },
    { id: "meta", label: "Metadata", role: "compute", group: "Catalog" },
    { id: "nodes", label: "Data nodes", role: "data", shape: "cylinder", group: "Data" },
    { id: "place", label: "Placement", role: "compute", group: "Placement" },
    { id: "replica", label: "Replication", role: "compute", group: "Placement" },
    { id: "log", label: "Durability log", role: "data", shape: "cylinder", group: "Durability" },
  ],
  links: ["Request", "Locate", "Read", "Place", "Replicate", "Append"],
  extra: [{ from: "api", to: "nodes", label: "Get", side: true }],
};

const MOTIFS: Blueprint[] = [CACHE, MESSAGING, AUTH, STORAGE];

function shapeFor(role: EntityRole, explicit?: ShapeKind): ShapeKind {
  if (explicit) return explicit;
  if (role === "data") return "cylinder";
  if (role === "storage") return "cloud";
  if (role === "bus") return "queue";
  if (role === "edge") return "hexagon";
  if (role === "actor") return "actor";
  return "rectangle";
}

function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function topicWords(message: string): string[] {
  const raw = message
    .replace(/[?.!]+$/g, "")
    .match(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g);
  if (!raw) return [];
  return raw.map((word) => word.toLowerCase()).filter((word) => !TOPIC_DROP.has(word));
}

function shortTopic(words: string[]): string {
  let kept = [...words];
  while (kept.length > 1 && LEADING.has(kept[0] ?? "")) kept = kept.slice(1);
  while (kept.length > 1 && TRAILING.has(kept[kept.length - 1] ?? "")) kept = kept.slice(0, -1);
  const text = titleCase(kept.slice(0, 4).join(" "));
  return text || "Service";
}

function matchMotif(message: string): Blueprint | null {
  const hits = MOTIFS.filter((motif) => motif.when.test(message));
  hits.sort((left, right) => right.rank - left.rank);
  return hits[0] ?? null;
}

/** True when the ask should be expanded instead of tokenized. */
export function shouldExpandSystem(message: string): boolean {
  if (TIER_ASK.test(message) || CLOSED_KIND.test(message)) return false;
  if (isInteractionAsk(message)) return true;
  if (/\barchitecture\s+of\b/i.test(message)) return true;
  return /\barchitectures?\b/i.test(message) && matchMotif(message) !== null;
}

function countsAsListed(entity: NamedEntity): boolean {
  if (entity.origin === "catalog" || entity.origin === "listed") return true;
  const label = entity.label.trim();
  if (/[.\d]/.test(label)) return true;
  const words = label.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (words.length >= 2 && MODIFIER_HEAD.has(words[0] ?? "")) return false;
  if (words.every((word) => word.length <= 2 || NOT_A_COMPONENT.has(word))) return false;
  return words.some((word) => word.length >= 4 && !NOT_A_COMPONENT.has(word));
}

function listedComponents(message: string): number {
  return extractNamedEntities(message).filter(countsAsListed).length;
}

function fallbackBlueprint(words: string[]): Blueprint {
  const name = shortTopic(words);
  return {
    rank: 0,
    when: /$^/,
    title: name,
    wiki: name,
    context: `A ${name} subsystem is called by clients through an API. A coordinator applies the core, checks policy, reads a state store, and syncs with peers.`,
    pieces: [
      { id: "clients", label: "Clients", role: "client", group: "Clients" },
      { id: "api", label: `${name} API`, role: "edge", shape: "hexagon", group: "Edge" },
      { id: "coord", label: "Coordinator", role: "compute", group: "Control" },
      { id: "core", label: `${name} core`, role: "compute", group: "Core" },
      { id: "policy", label: "Policy", role: "compute", group: "Policy" },
      { id: "state", label: "State store", role: "data", shape: "cylinder", group: "Data" },
      { id: "peers", label: "Peers", role: "compute", group: "Peers" },
    ],
    links: ["Request", "Route", "Apply", "Check", "Read", "Sync"],
    extra: [{ from: "api", to: "state", label: "Lookup", side: true }],
  };
}

function realize(blueprint: Blueprint, message: string): OpenSystem {
  const horizontal = requestedLayout(message) === "horizontal";
  const perRole = new Map<EntityRole, number>();
  const groups: OpenGroup[] = [];
  for (const piece of blueprint.pieces) {
    const index = perRole.get(piece.role) ?? 0;
    perRole.set(piece.role, index + 1);
    const paint = rolePaint(piece.role, index);
    const node: OpenNode = {
      id: piece.id,
      label: piece.label,
      shape: shapeFor(piece.role, piece.shape),
      fill: paint.fill,
      stroke: paint.stroke,
    };
    const current = groups[groups.length - 1];
    // A horizontal row keeps one vertex per container. Stacking several in one band overlaps them.
    if (!horizontal && current && current.label === piece.group) current.nodes.push(node);
    else {
      const raw = (horizontal ? piece.id : piece.group).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const id = groups.some((group) => group.id === raw) ? `${raw}-${groups.length}` : raw || piece.id;
      groups.push({ id, label: piece.group, nodes: [node] });
    }
  }
  const ordered = blueprint.pieces;
  const edges: OpenEdge[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index];
    const to = ordered[index + 1];
    if (!from || !to) continue;
    edges.push({ from: from.id, to: to.id, label: blueprint.links[index] ?? "Call" });
  }
  if (!horizontal) {
    for (const extra of blueprint.extra ?? []) edges.push(extra);
  }
  const labels = ordered.map((piece) => piece.label);
  return {
    title: blueprint.title,
    reply: `Drew ${blueprint.title}: ${labels.join(" → ")}.`,
    context: blueprint.context,
    researchTopic: blueprint.wiki,
    axis: horizontal ? "horizontal" : undefined,
    groups,
    edges,
  };
}

/**
 * A rich architecture for an underspecified system ask.
 * Null when the user already listed the components, or the sentence is not that ask.
 */
export function expandOpenSystem(message: string): OpenSystem | null {
  const text = message.trim();
  if (!text || !shouldExpandSystem(text)) return null;
  if (listedComponents(text) >= 2) return null;
  const motif = matchMotif(text);
  if (motif) return realize(motif, text);
  const words = topicWords(text);
  if (words.length === 0) return null;
  return realize(fallbackBlueprint(words), text);
}

export function openSystemBrief(message: string): { topic: string; summary: string } | null {
  const system = expandOpenSystem(message);
  if (!system) return null;
  return { topic: system.researchTopic ?? system.title, summary: system.context };
}
