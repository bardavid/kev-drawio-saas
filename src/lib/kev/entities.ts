import { PALETTE, inferShape, type ShapeKind } from "@/lib/drawio/styles";

/**
 * Named services, steps, actors, and states pulled from the words the user
 * actually used. Matching is by phrase and synonym, never by the whole prompt.
 * A paraphrase that names the same entities composes the same diagram.
 */

export type EntityRole = "actor" | "client" | "edge" | "compute" | "step" | "data" | "storage" | "bus";

export interface NamedEntity {
  id: string;
  label: string;
  role: EntityRole;
  shape: ShapeKind;
  fill: string;
  stroke: string;
  /** Catalog hit, a listed generic, or a free-standing name such as Orders. */
  origin: "catalog" | "listed" | "adhoc";
}

export interface NamedDiagram {
  title: string;
  reply: string;
  kind: "layers" | "sequence";
  groups: Array<{ id: string; label: string; flow: "row" | "column"; nodes: NamedEntity[] }>;
  edges: Array<{ from: string; to: string; label: string; side?: boolean }>;
  /** Appearance order. Sequence diagrams use this instead of role groups. */
  participants: NamedEntity[];
  messages: Array<{ from: string; to: string; label: string; dashed?: boolean }>;
}

interface CatalogEntry {
  id: string;
  label: string;
  role: EntityRole;
  shape?: ShapeKind;
  phrases: string[];
  /** When set, the short phrase only counts in this context. */
  when?: (text: string) => boolean;
  /** Match only as its own list item, not inside a longer sentence. */
  listed?: boolean;
}

const ROLE_COLOR: Record<EntityRole, string> = {
  actor: "gray",
  client: "orange",
  edge: "teal",
  compute: "green",
  step: "yellow",
  data: "blue",
  storage: "purple",
  bus: "pink",
};

const PASTEL_CYCLE = ["orange", "green", "blue", "purple", "yellow", "teal", "pink"];

const GROUP_LABEL: Record<EntityRole, string> = {
  actor: "Actors",
  client: "Clients",
  edge: "Edge",
  compute: "Services",
  step: "Steps",
  data: "Data",
  storage: "Storage",
  bus: "Messaging",
};

const ROLE_ORDER: EntityRole[] = ["actor", "client", "edge", "compute", "step", "data", "storage", "bus"];
const FRONT = new Set<EntityRole>(["actor", "client", "edge", "compute", "step"]);
const SINK = new Set<EntityRole>(["data", "storage", "bus"]);

const CATALOG: CatalogEntry[] = [
  { id: "api-gateway", label: "API Gateway", role: "edge", shape: "hexagon", phrases: ["amazon api gateway", "api gateway", "apigw", "api gw"] },
  { id: "lambda", label: "Lambda", role: "compute", phrases: ["aws lambda", "lambda"] },
  { id: "sqs", label: "SQS", role: "bus", shape: "queue", phrases: ["simple queue service", "sqs"] },
  { id: "sns", label: "SNS", role: "bus", shape: "queue", phrases: ["simple notification service", "sns"] },
  { id: "dynamodb", label: "DynamoDB", role: "data", shape: "cylinder", phrases: ["dynamo db", "dynamodb"] },
  { id: "cloudfront", label: "CloudFront", role: "edge", phrases: ["cloud front", "cloudfront"] },
  { id: "s3", label: "S3", role: "storage", shape: "cloud", phrases: ["simple storage service", "s3"] },
  { id: "alb", label: "ALB", role: "edge", shape: "hexagon", phrases: ["application load balancer", "alb"] },
  { id: "ecs-fargate", label: "ECS Fargate", role: "compute", phrases: ["ecs fargate", "fargate"] },
  { id: "ecs", label: "ECS", role: "compute", phrases: ["ecs"] },
  { id: "rds", label: "RDS", role: "data", shape: "cylinder", phrases: ["rds"] },
  { id: "elasticache", label: "ElastiCache", role: "data", shape: "cylinder", phrases: ["elasti cache", "elasticache"] },
  { id: "apim", label: "API Management", role: "edge", shape: "hexagon", phrases: ["api management", "apim"] },
  { id: "azure-functions", label: "Azure Functions", role: "compute", phrases: ["azure functions"] },
  {
    id: "azure-functions",
    label: "Azure Functions",
    role: "compute",
    phrases: ["functions"],
    when: (text) => /\b(azure|apim|api management)\b/i.test(text),
  },
  { id: "cosmos", label: "Cosmos DB", role: "data", shape: "cylinder", phrases: ["cosmos db", "cosmosdb", "cosmos"] },
  { id: "event-hubs", label: "Event Hubs", role: "bus", shape: "queue", phrases: ["event hubs", "event hub"] },
  { id: "app-gateway", label: "Application Gateway", role: "edge", shape: "hexagon", phrases: ["application gateway", "app gateway"] },
  { id: "app-service", label: "App Service", role: "compute", phrases: ["app service"] },
  { id: "azure-sql", label: "Azure SQL", role: "data", shape: "cylinder", phrases: ["azure sql"] },
  { id: "service-bus", label: "Service Bus", role: "bus", shape: "queue", phrases: ["service bus"] },
  { id: "blob", label: "Blob Storage", role: "storage", shape: "cloud", phrases: ["blob storage"] },
  { id: "key-vault", label: "Key Vault", role: "compute", phrases: ["key vault"] },
  { id: "aks", label: "AKS", role: "compute", phrases: ["azure kubernetes service", "aks"] },
  { id: "cloud-lb", label: "Cloud Load Balancing", role: "edge", shape: "hexagon", phrases: ["cloud load balancing", "cloud lb"] },
  { id: "cloud-run", label: "Cloud Run", role: "compute", phrases: ["cloud run"] },
  { id: "cloud-functions", label: "Cloud Functions", role: "compute", phrases: ["cloud functions"] },
  { id: "cloud-sql", label: "Cloud SQL", role: "data", shape: "cylinder", phrases: ["cloud sql"] },
  { id: "pubsub", label: "Pub/Sub", role: "bus", shape: "queue", phrases: ["cloud pub/sub", "cloud pubsub", "pub/sub", "pubsub"] },
  { id: "dataflow", label: "Dataflow", role: "compute", phrases: ["dataflow"] },
  { id: "bigquery", label: "BigQuery", role: "data", shape: "cylinder", phrases: ["bigquery", "big query"] },
  { id: "memorystore", label: "Memorystore", role: "data", shape: "cylinder", phrases: ["memorystore"] },
  { id: "gke", label: "GKE", role: "compute", phrases: ["google kubernetes engine", "gke"] },
  { id: "gcs", label: "Cloud Storage", role: "storage", shape: "cloud", phrases: ["cloud storage", "gcs"] },
  { id: "cf-workers", label: "Workers", role: "edge", shape: "hexagon", phrases: ["cloudflare workers"] },
  {
    id: "cf-workers",
    label: "Workers",
    role: "edge",
    shape: "hexagon",
    phrases: ["workers"],
    when: (text) => /\bcloudflare\b/i.test(text),
  },
  { id: "d1", label: "D1", role: "data", shape: "cylinder", phrases: ["d1 database", "d1"] },
  { id: "r2", label: "R2", role: "storage", shape: "cloud", phrases: ["r2 object storage", "r2 bucket", "r2"] },
  { id: "cf-queues", label: "Queues", role: "bus", shape: "queue", phrases: ["cloudflare queues"] },
  {
    id: "cf-queues",
    label: "Queues",
    role: "bus",
    shape: "queue",
    phrases: ["queues"],
    when: (text) => /\bcloudflare\b/i.test(text),
  },
  { id: "stripe-checkout", label: "Stripe Checkout", role: "compute", phrases: ["stripe checkout"] },
  {
    id: "stripe-checkout",
    label: "Stripe Checkout",
    role: "compute",
    phrases: ["checkout page"],
    when: (text) => /\bstripe\b/i.test(text),
  },
  {
    id: "webhook",
    label: "Webhook handler",
    role: "compute",
    phrases: ["webhook handler", "webhook receiver", "webhook endpoint", "webhook"],
  },
  { id: "github-actions", label: "GitHub Actions", role: "step", phrases: ["github actions"] },
  { id: "deploy-vercel", label: "Deploy to Vercel", role: "step", phrases: ["deploy to vercel"] },
  { id: "auth-service", label: "Auth Service", role: "compute", phrases: ["auth service", "authentication service"] },
  { id: "orders-service", label: "Orders Service", role: "compute", phrases: ["orders service"] },
  { id: "authorization-server", label: "Authorization Server", role: "compute", phrases: ["authorization server"] },
  { id: "resource-server", label: "Resource Server", role: "compute", phrases: ["resource server"] },
  { id: "resource-api", label: "Resource API", role: "compute", phrases: ["resource api"] },
  { id: "message-bus", label: "Message bus", role: "bus", shape: "queue", phrases: ["message bus", "event bus"] },
  { id: "kafka", label: "Kafka", role: "bus", shape: "queue", phrases: ["kafka"] },
  { id: "postgres", label: "Postgres", role: "data", shape: "cylinder", phrases: ["postgresql", "postgres"] },
  { id: "redis", label: "Redis", role: "data", shape: "cylinder", phrases: ["redis"] },
  { id: "mysql", label: "MySQL", role: "data", shape: "cylinder", phrases: ["mysql"] },
  { id: "mongo", label: "MongoDB", role: "data", shape: "cylinder", phrases: ["mongodb", "mongo"] },
  { id: "object-storage", label: "Object storage", role: "storage", shape: "cloud", phrases: ["object storage"] },
  { id: "browser", label: "Browser", role: "client", phrases: ["browser"], listed: true },
  { id: "client", label: "Client", role: "client", phrases: ["client"], listed: true },
  { id: "user", label: "User", role: "actor", shape: "actor", phrases: ["user"], listed: true },
  { id: "api", label: "API", role: "compute", phrases: ["api"], listed: true },
  { id: "app", label: "App", role: "compute", phrases: ["app"], listed: true },
  { id: "database", label: "Database", role: "data", shape: "cylinder", phrases: ["database", "db"], listed: true },
  { id: "cache", label: "Cache", role: "data", shape: "cylinder", phrases: ["cache"], listed: true },
  { id: "queue", label: "Queue", role: "bus", shape: "queue", phrases: ["queue"], listed: true },
  { id: "build", label: "Build", role: "step", phrases: ["build"], listed: true },
  { id: "web", label: "Web", role: "client", phrases: ["web"], listed: true },
];

const CUE = new Set([
  "please", "draw", "sketch", "show", "illustrate", "map", "build", "create", "architect",
  "architecture", "architectures", "stack", "stacks", "path", "paths", "diagram", "diagrams",
  "sequence", "sequences", "flow", "flowchart", "pipeline", "system", "systems", "edge",
  "messaging", "payment", "payments", "simple", "basic", "blank", "canvas", "using", "include",
  "including", "with", "via", "then", "and", "plus", "front", "ahead", "behind", "underneath",
  "above", "below", "fan", "out", "through", "into", "onto", "from", "for", "the", "a", "an",
  "on", "in", "of", "to", "up", "it", "its", "work", "result", "afterwards", "sits", "put",
  "where", "after", "before", "every", "box", "boxes", "shape", "shapes", "node", "nodes",
  "arrow", "arrows", "edges", "connector", "connectors", "line", "lines",
  "footprint", "route", "card", "stream", "streaming", "storage", "object", "named", "called",
  "azure", "aws", "amazon", "gcp", "google", "cloudflare", "stripe", "payment",
  "side", "also", "just", "me", "my", "our", "their", "shopper", "customer", "records", "record",
  "page", "call", "sits", "ahead", "behind", "hang", "off", "them", "tier", "web", "app",
  "orange", "green", "blue", "purple", "yellow", "red", "teal", "pink", "gray", "grey", "black", "white",
  "horizontal", "horizontally", "vertical", "vertically", "column", "columns", "row", "rows",
  "stacked", "stack", "left", "right", "top", "bottom", "down",
]);

const MODIFIERS = new Set([
  "shopper", "customer", "end", "our", "their", "my", "incoming", "existing", "primary", "main",
  "internal", "external", "simple", "basic", "new", "the", "a", "an", "user", "page", "service",
]);

interface PhraseHit {
  entry: CatalogEntry;
  phrase: string;
}

const PHRASES: PhraseHit[] = CATALOG.filter((entry) => !entry.listed)
  .flatMap((entry) => entry.phrases.map((phrase) => ({ entry, phrase: phrase.toLowerCase() })))
  .sort((left, right) => right.phrase.length - left.phrase.length);

const LISTED: PhraseHit[] = CATALOG.filter((entry) => entry.listed).flatMap((entry) =>
  entry.phrases.map((phrase) => ({ entry, phrase: phrase.toLowerCase() })),
);

interface Span {
  start: number;
  end: number;
  entry: CatalogEntry;
}

function normalize(text: string): string {
  return text
    .replace(/['’]s\b/g, "")
    .replace(/['’]/g, "")
    .replace(/[—–]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(hay: string, start: number, end: number): boolean {
  const before = start === 0 ? " " : hay[start - 1] ?? " ";
  const after = end >= hay.length ? " " : hay[end] ?? " ";
  return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
}

function overlaps(left: Span, right: Span): boolean {
  return left.start < right.end && right.start < left.end;
}

function catalogSpans(text: string): Span[] {
  const hay = text.toLowerCase();
  const found: Span[] = [];
  for (const hit of PHRASES) {
    if (hit.entry.when && !hit.entry.when(text)) continue;
    let from = 0;
    while (from < hay.length) {
      const at = hay.indexOf(hit.phrase, from);
      if (at === -1) break;
      const end = at + hit.phrase.length;
      if (bounded(hay, at, end)) found.push({ start: at, end, entry: hit.entry });
      from = at + Math.max(1, hit.phrase.length);
    }
  }
  found.sort((left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start);
  const accepted: Span[] = [];
  for (const span of found) {
    if (accepted.some((other) => overlaps(span, other))) continue;
    accepted.push(span);
  }
  accepted.sort((left, right) => left.start - right.start);
  return accepted;
}

const SEGMENT_SPLIT =
  /\s*(?:,|;|:|\+|\/|&|→|->|=>)\s*|\s+\b(?:and|then|via|using|with|including|include|plus|alongside|into|through|before)\b\s+|\s+\b(?:in front of|ahead of|followed by|fan(?:s|ned)? out(?:\s+(?:via|through|to|with))?)\b\s+/gi;

function segmentsOf(text: string): Array<{ start: number; end: number; text: string }> {
  const parts: Array<{ start: number; end: number; text: string }> = [];
  const pattern = new RegExp(SEGMENT_SPLIT.source, "gi");
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    const slice = text.slice(cursor, at).trim();
    if (slice) {
      const start = text.indexOf(slice, cursor);
      parts.push({ start, end: start + slice.length, text: slice });
    }
    cursor = at + match[0].length;
  }
  const tail = text.slice(cursor).trim();
  if (tail) {
    const start = text.indexOf(tail, cursor);
    parts.push({ start, end: start + tail.length, text: tail });
  }
  return parts;
}

function wordsOf(segment: string): string[] {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9\s/+-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function containsPhrase(words: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > words.length) return false;
  for (let index = 0; index <= words.length - phrase.length; index += 1) {
    if (phrase.every((word, offset) => words[index + offset] === word)) return true;
  }
  return false;
}

function withoutPhrase(words: string[], phrase: string[]): string[] {
  for (let index = 0; index <= words.length - phrase.length; index += 1) {
    if (phrase.every((word, offset) => words[index + offset] === word)) {
      return [...words.slice(0, index), ...words.slice(index + phrase.length)];
    }
  }
  return words;
}

function listedEntry(segment: string, text: string): CatalogEntry | null {
  const words = wordsOf(segment).filter((word) => !/^(?:a|an|the)$/.test(word));
  if (words.length === 0 || words.length > 4) return null;
  for (const hit of LISTED) {
    if (hit.entry.when && !hit.entry.when(text)) continue;
    const phrase = hit.phrase.split(/\s+/);
    if (!containsPhrase(words, phrase)) continue;
    const rest = withoutPhrase(words, phrase);
    if (rest.every((word) => MODIFIERS.has(word))) return hit.entry;
  }
  return null;
}

function titleLabel(words: string[]): string {
  return words
    .map((word) => {
      if (word.length > 1 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

const HARD_CUE = new Set([
  "sequence",
  "architecture",
  "diagram",
  "stack",
  "path",
  "pipeline",
  "flowchart",
  "workflow",
  "lifecycle",
  "system",
  "please",
  "draw",
  "sketch",
]);

function adHoc(segment: string): { label: string; role: EntityRole } | null {
  const raw = wordsOf(segment);
  if (raw.some((word) => HARD_CUE.has(word))) return null;
  const words = raw.filter((word) => !CUE.has(word) && !/^\d+$/.test(word));
  if (words.length === 0 || words.length > 3) return null;
  if (words.every((word) => MODIFIERS.has(word))) return null;
  const label = titleLabel(words);
  if (label.length < 2) return null;
  return { label, role: inferRole(label) };
}

function inferRole(label: string): EntityRole {
  const text = label.toLowerCase();
  if (/\b(database|postgres|mysql|mongo|cosmos|dynamo|sql|db|d1)\b/.test(text)) return "data";
  if (/\b(storage|bucket|blob|s3|r2)\b/.test(text)) return "storage";
  if (/\b(queue|queues|bus|kafka|sqs|sns|hub|pubsub)\b/.test(text)) return "bus";
  if (/\b(gateway|apim|balancer|cloudfront)\b/.test(text)) return "edge";
  if (/\b(browser|client|shopper)\b/.test(text)) return "client";
  if (/\b(user|actor|customer)\b/.test(text)) return "actor";
  return "compute";
}

function shapeFor(entry: { role: EntityRole; shape?: ShapeKind }, label: string): ShapeKind {
  if (entry.shape) return entry.shape;
  if (entry.role === "data") return "cylinder";
  if (entry.role === "storage") return "cloud";
  if (entry.role === "bus") return "queue";
  if (entry.role === "edge") return "hexagon";
  if (entry.role === "actor") return "actor";
  return inferShape(label);
}

function pastel(role: EntityRole, indexInRole: number): { fill: string; stroke: string } {
  const name = indexInRole === 0 ? ROLE_COLOR[role] : PASTEL_CYCLE[(indexInRole + ROLE_ORDER.indexOf(role)) % PASTEL_CYCLE.length]!;
  const color = PALETTE[name] ?? PALETTE.blue!;
  return { fill: color.fill, stroke: color.stroke };
}

function slug(label: string, used: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

interface Draft {
  id: string;
  label: string;
  role: EntityRole;
  shape: ShapeKind;
  order: number;
  origin: NamedEntity["origin"];
}

/** Concrete services, steps, actors, and states named in the message. */
export function extractNamedEntities(message: string): NamedEntity[] {
  const text = normalize(message);
  if (!text) return [];
  const spans = catalogSpans(text);
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    if (seen.has(span.entry.id)) continue;
    seen.add(span.entry.id);
    drafts.push({
      id: span.entry.id,
      label: span.entry.label,
      role: span.entry.role,
      shape: shapeFor(span.entry, span.entry.label),
      order: span.start,
      origin: "catalog",
    });
  }

  for (const segment of segmentsOf(text)) {
    const covered = spans.some((span) => span.start < segment.end && segment.start < span.end);
    if (covered) continue;
    const listed = listedEntry(segment.text, text);
    if (listed) {
      if (seen.has(listed.id)) continue;
      seen.add(listed.id);
      drafts.push({
        id: listed.id,
        label: listed.label,
        role: listed.role,
        shape: shapeFor(listed, listed.label),
        order: segment.start,
        origin: "listed",
      });
      continue;
    }
    const extra = adHoc(segment.text);
    if (!extra) continue;
    const key = extra.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      id: key,
      label: extra.label,
      role: extra.role,
      shape: shapeFor({ role: extra.role }, extra.label),
      order: segment.start,
      origin: "adhoc",
    });
  }

  drafts.sort((left, right) => left.order - right.order);
  const used = new Set<string>();
  const perRole = new Map<EntityRole, number>();
  return drafts.map((draft) => {
    const index = perRole.get(draft.role) ?? 0;
    perRole.set(draft.role, index + 1);
    const paint = pastel(draft.role, index);
    return {
      id: slug(draft.id, used),
      label: draft.label,
      role: draft.role,
      shape: draft.shape,
      fill: paint.fill,
      stroke: paint.stroke,
      origin: draft.origin,
    };
  });
}

function linkLabel(from: NamedEntity, to: NamedEntity): string {
  if (to.role === "data") return "Query";
  if (to.role === "storage") return "Put / Get";
  if (to.role === "bus") {
    if (/sns|notification/i.test(to.label)) return "Publish";
    if (/sqs|\bqueue/i.test(to.label)) return "Send";
    return "Publish";
  }
  if (from.role === "client" || from.role === "actor" || to.role === "edge") return "HTTPS";
  if (to.role === "compute" && from.role === "edge") {
    return /lambda|function|worker/i.test(to.label) ? "Invoke" : "Route";
  }
  if (to.role === "step" || from.role === "step") return "Next";
  return "Call";
}

interface DiagramEdge {
  from: string;
  to: string;
  label: string;
  side?: boolean;
}

function pushEdge(edges: DiagramEdge[], from: NamedEntity, to: NamedEntity, side = false) {
  if (from.id === to.id) return;
  if (edges.some((edge) => edge.from === from.id && edge.to === to.id)) return;
  edges.push(side ? { from: from.id, to: to.id, label: linkLabel(from, to), side: true } : { from: from.id, to: to.id, label: linkLabel(from, to) });
}

function connectTiers(previous: NamedEntity[], current: NamedEntity[], edges: DiagramEdge[]) {
  const source = previous[0];
  const target = current[0];
  if (!source || !target) return;
  if (previous.length === 1 && current.length === 1) {
    pushEdge(edges, source, target);
    return;
  }
  if (previous.length === 1) {
    current.forEach((node, index) => pushEdge(edges, source, node, index > 0));
    return;
  }
  if (current.length === 1) {
    previous.forEach((node, index) => pushEdge(edges, node, target, index > 0));
    return;
  }
  const count = Math.max(previous.length, current.length);
  for (let index = 0; index < count; index += 1) {
    const from = previous[Math.min(index, previous.length - 1)];
    const to = current[Math.min(index, current.length - 1)];
    if (from && to) pushEdge(edges, from, to, index > 0);
  }
}

function layerEdges(nodes: NamedEntity[]): DiagramEdge[] {
  const byRole = new Map<EntityRole, NamedEntity[]>();
  for (const node of nodes) {
    const list = byRole.get(node.role) ?? [];
    list.push(node);
    byRole.set(node.role, list);
  }
  const present = ROLE_ORDER.filter((role) => (byRole.get(role)?.length ?? 0) > 0);
  const edges: DiagramEdge[] = [];
  const sinkNodes = present.filter((role) => SINK.has(role)).flatMap((role) => byRole.get(role) ?? []);
  const sequential = present.every((role) => (byRole.get(role)?.length ?? 0) === 1);
  if (sequential && sinkNodes.length <= 1) {
    const ordered = present.flatMap((role) => byRole.get(role) ?? []);
    for (let index = 1; index < ordered.length; index += 1) {
      const from = ordered[index - 1];
      const to = ordered[index];
      if (from && to) pushEdge(edges, from, to);
    }
    return edges;
  }

  const frontRoles = present.filter((role) => FRONT.has(role));
  let previous: NamedEntity[] = [];
  for (const role of frontRoles) {
    const current = byRole.get(role) ?? [];
    connectTiers(previous, current, edges);
    previous = current;
  }
  if (previous.length > 0 && sinkNodes.length > 0) {
    if (previous.length === 1) {
      sinkNodes.forEach((sink, index) => {
        const source = previous[0];
        if (source) pushEdge(edges, source, sink, index > 0);
      });
    } else {
      for (const source of previous) {
        sinkNodes.forEach((sink, index) => pushEdge(edges, source, sink, index > 0));
      }
    }
  }
  return edges;
}

function topicTitle(text: string): string | null {
  if (/\bcloudflare\b/i.test(text)) return "Cloudflare";
  if (/\bazure\b/i.test(text)) return "Azure";
  if (/\b(aws|amazon)\b/i.test(text)) return "AWS";
  if (/\bstripe\b/i.test(text)) return "Stripe";
  if (/\b(gcp|google cloud)\b/i.test(text)) return "GCP";
  if (/\bmicroservice/i.test(text)) return "Microservices";
  if (/\bsequence\b/i.test(text)) return "Sequence";
  return null;
}

/** A layered or sequence diagram made only from the entities the user named. */
export function composeNamedDiagram(message: string, entities?: NamedEntity[]): NamedDiagram | null {
  const text = normalize(message);
  const nodes = entities ?? extractNamedEntities(text);
  if (nodes.length < 2) return null;
  const sequence = /\bsequence\b/i.test(text);
  const labels = nodes.map((node) => node.label);
  const title = topicTitle(text) ?? "Architecture";
  const reply = `Drew ${title} with ${labels.join(", ")}.`;
  const byRole = new Map<EntityRole, NamedEntity[]>();
  for (const node of nodes) {
    const list = byRole.get(node.role) ?? [];
    list.push(node);
    byRole.set(node.role, list);
  }
  const groups = ROLE_ORDER.filter((role) => byRole.has(role)).map((role) => {
    const groupNodes = byRole.get(role) ?? [];
    return {
      id: `group-${role}`,
      label: GROUP_LABEL[role],
      flow: groupNodes.length > 1 ? ("row" as const) : ("column" as const),
      nodes: groupNodes,
    };
  });
  const edges = layerEdges(nodes);
  const messages = nodes.slice(1).map((node, index) => {
    const from = nodes[index];
    return {
      from: from?.id ?? node.id,
      to: node.id,
      label: from ? linkLabel(from, node) : "Next",
    };
  });
  return {
    title,
    reply,
    kind: sequence ? "sequence" : "layers",
    groups,
    edges,
    participants: nodes,
    messages,
  };
}
