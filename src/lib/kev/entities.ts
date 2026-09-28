import { PALETTE, inferShape, type ShapeKind } from "@/lib/drawio/styles";
import { PLACEMENT_MANNER_TOKENS } from "@/lib/kev/plan";

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
  {
    id: "object-storage",
    label: "Object storage",
    role: "storage",
    shape: "cloud",
    phrases: ["object storage", "object store", "blobs", "blob", "objects"],
  },
  {
    id: "spa",
    label: "SPA",
    role: "client",
    phrases: ["single page application", "single-page application", "single page app", "single-page app", "spa"],
  },
  {
    id: "ui",
    label: "UI",
    role: "client",
    phrases: ["user interface", "ui"],
    // "SPA for the UI" names the SPA. The purpose gloss is not a second tier.
    when: (text) => !/\bfor\s+(?:the\s+)?(?:ui|user interface)\b/i.test(text),
  },
  {
    id: "app-servers",
    label: "Application servers",
    role: "compute",
    phrases: ["application servers", "application server", "app servers", "app server"],
  },
  {
    id: "business-logic",
    label: "Business logic",
    role: "compute",
    phrases: ["business logic"],
    when: (text) => !/\bfor\s+(?:the\s+)?business logic\b/i.test(text),
  },
  { id: "browser", label: "Browser", role: "client", phrases: ["browser"], listed: true },
  { id: "client", label: "Client", role: "client", phrases: ["client"], listed: true },
  { id: "user", label: "User", role: "actor", shape: "actor", phrases: ["user"], listed: true },
  { id: "api", label: "API", role: "compute", phrases: ["api"], listed: true },
  { id: "app", label: "App", role: "compute", phrases: ["app"], listed: true },
  { id: "application", label: "Application", role: "compute", phrases: ["application"], listed: true },
  { id: "database", label: "Database", role: "data", shape: "cylinder", phrases: ["database", "db"], listed: true },
  { id: "cache", label: "Cache", role: "data", shape: "cylinder", phrases: ["cache"], listed: true },
  { id: "queue", label: "Queue", role: "bus", shape: "queue", phrases: ["queue"], listed: true },
  { id: "build", label: "Build", role: "step", phrases: ["build"], listed: true },
  { id: "test", label: "Test", role: "step", phrases: ["test"], listed: true },
  { id: "deploy", label: "Deploy", role: "step", phrases: ["deploy"], listed: true },
  { id: "web", label: "Web", role: "client", phrases: ["web"], listed: true },
];

const CUE = new Set([
  "please", "draw", "sketch", "show", "illustrate", "map", "build", "create", "architect",
  "architecture", "architectures", "stack", "stacks", "path", "paths", "diagram", "diagrams",
  "sequence", "sequences", "flow", "flowchart", "pipeline", "system", "systems", "edge",
  "choreography", "choreograph", "choreographed",
  "messaging", "payment", "payments", "simple", "basic", "blank", "canvas", "using", "include",
  "including", "with", "via", "then", "and", "plus", "front", "ahead", "behind", "underneath",
  "above", "below", "fan", "out", "through", "into", "onto", "from", "for", "the", "a", "an",
  "on", "in", "of", "to", "up", "it", "its", "work", "result", "afterwards", "sits", "put",
  "where", "after", "before", "every", "box", "boxes", "shape", "shapes", "node", "nodes",
  "arrow", "arrows", "edges", "connector", "connectors", "line", "lines",
  "footprint", "route", "card", "stream", "streaming", "storage", "object", "named", "called",
  "azure", "aws", "amazon", "gcp", "google", "payment",
  "side", "also", "just", "me", "my", "our", "their", "shopper", "customer", "records", "record",
  "page", "call", "sits", "ahead", "behind", "hang", "off", "them", "tier", "web", "app",
  "orange", "green", "blue", "purple", "yellow", "red", "teal", "pink", "gray", "grey", "black", "white",
  "horizontal", "horizontally", "vertical", "vertically", "column", "columns", "row", "rows",
  "stacked", "stack", "left", "right", "top", "bottom", "down",
]);

const MODIFIERS = new Set([
  "shopper", "customer", "end", "our", "their", "my", "incoming", "existing", "primary", "main",
  "internal", "external", "simple", "basic", "new", "the", "a", "an", "user", "page", "service",
  "box", "boxes",
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
    let from = 0;
    while (from < hay.length) {
      const at = hay.indexOf(hit.phrase, from);
      if (at === -1) break;
      const end = at + hit.phrase.length;
      if (!bounded(hay, at, end)) {
        from = at + Math.max(1, hit.phrase.length);
        continue;
      }
      // A short phrase gated on a vendor ("workers" when the text says Cloudflare)
      // only counts beside that vendor, not anywhere in a long stack description.
      if (hit.entry.when) {
        const window = text.slice(Math.max(0, at - 48), Math.min(text.length, end + 48));
        if (!hit.entry.when(window)) {
          from = at + Math.max(1, hit.phrase.length);
          continue;
        }
      }
      found.push({ start: at, end, entry: hit.entry });
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
  /\s*(?:,|;|:|\?|!|\.\s+|\+|\/|&|→|->|=>)\s*|\s+\b(?:and|then|via|using|with|including|include|plus|alongside|into|through|before)\b\s+|\s+\b(?:in front of|ahead of|followed by|fan(?:s|ned)? out(?:\s+(?:via|through|to|with))?)\b\s+/gi;

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
  return (segment.match(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g) ?? []).map((word) => word.toLowerCase());
}

const ROLE_WORDS = new Set<string>();
for (const hit of [...PHRASES, ...LISTED]) {
  for (const word of hit.phrase.split(/\s+/)) ROLE_WORDS.add(word);
}

/** Adjectives in a title ("Complex 3 Tier") are not service names. */
const TITLE_WORD = new Set(["complex", "simple", "basic", "clean", "sample", "example", "generic", "modern"]);

function looksNamed(token: string, segment: string): boolean {
  if (/^\d+$/.test(token) || TITLE_WORD.has(token)) return false;
  if (token.includes(".") || /\d/.test(token)) return true;
  const match = segment.match(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
  if (!match || match.index === undefined) return false;
  const raw = segment.slice(match.index, match.index + match[0].length);
  return /^[A-Z]/.test(raw);
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
    // "then the database" keeps Database. Glue around a listed noun is not another node.
    if (rest.every((word) => MODIFIERS.has(word) || CUE.has(word) || FLUFF.has(word) || GLOSS.has(word))) {
      return hit.entry;
    }
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
  "layout",
  "choreography",
  "choreograph",
]);

/**
 * Style and grammar. Never a vertex, even when the sentence capitalizes them.
 * "pastel fills", "labeled", "each", "own", "into place".
 */
const FLUFF = new Set([
  "pastel",
  "fill",
  "fills",
  "filled",
  "filling",
  "labeled",
  "labelled",
  "unlabeled",
  "unlabelled",
  "label",
  "labels",
  "container",
  "containers",
  "topic",
  "topics",
  "color",
  "colors",
  "colour",
  "colours",
  "palette",
  "style",
  "styles",
  "styled",
  "styling",
  "each",
  "own",
  "per",
  "both",
  "either",
  "another",
  "such",
  "same",
  "various",
  "multiple",
  "several",
  "every",
  "into",
  "onto",
  "within",
  "without",
  "across",
  "between",
  "among",
  "around",
  "inside",
  "outside",
  "near",
  "over",
  "under",
  "place",
  "places",
  "placed",
  "intact",
  "kept",
  "keeping",
  "brands",
  "brand",
  "pattern",
  "patterns",
  "clearly",
  "production",
  "dense",
  "live",
  "saas",
  "region",
  "regions",
  "multi-region",
  "door",
  "doors",
  "observability",
]);

/**
 * Words that describe a product. They must not replace it.
 * A few of them may sit beside an uncommon brand ("Stripe Billing", "Cloudflare CDN").
 * "Data layer" names the job of a database already in the clause, so it must not
 * rename Postgres or MySQL. A tier that is only "a data layer" still becomes Data.
 */
const GLOSS = new Set([
  "data",
  "layer",
  "layers",
  "events",
  "event",
  "media",
  "uploads",
  "upload",
  "hot",
  "reads",
  "read",
  "worker",
  "workers",
  "fleet",
  "search",
  "searches",
  "hosted",
  "hosting",
  "host",
  "traffic",
  "domain",
  "domains",
  "background",
  "handles",
  "handle",
  "handling",
  "carries",
  "carry",
  "stores",
  "store",
  "storing",
  "stored",
  "wire",
  "wires",
  "wired",
  "exporting",
  "exports",
  "export",
  "writes",
  "write",
  "writing",
  "objects",
  "backed",
  "backing",
  "running",
  "runs",
  "talking",
  "sits",
  "sit",
  "sitting",
  "fans",
  "flowing",
  "flows",
  "release",
  "releases",
  "at",
  "by",
  "as",
  "is",
  "are",
  "was",
  "be",
  "been",
  "hit",
  "hits",
  "miss",
  "misses",
  "populate",
  "populates",
  "populated",
  "returns",
  "return",
  "goes",
  "going",
  "loads",
  "load",
  "loaded",
  "cache-aside",
  "lookaside",
  "look-aside",
  "aside",
  "ci",
  "cd",
  "use",
  "uses",
  "using",
  "three",
  "two",
  "four",
  "five",
  "one",
  "login",
  "logins",
  "sign-in",
  "signin",
  "sign-up",
  "signup",
  "payments",
  "payment",
  "billing",
  "cdn",
  "waf",
  "services",
  "servers",
  "application",
  "applications",
  "microservices",
  "microservice",
  "components",
  "component",
  "holds",
  "hold",
  "holding",
  "keeps",
  "sends",
  "send",
  "receives",
  "receive",
  "calls",
  "call",
]);

/** Role words that stay on the label when an uncommon brand is right beside them. */
const BESIDE = new Set(["billing", "cdn", "waf"]);

/** A vendor name used as a diagram title, not a box, unless a component sits beside it. */
const TITLE_VENDOR = new Set(["cloudflare", "stripe", "aws", "azure", "gcp", "amazon", "google"]);

/** Clause crumbs. They choose a role or point at one; they are not a node. */
const CRUMB = new Set([
  "there",
  "here",
  "that",
  "this",
  "these",
  "those",
  "keeps",
  "keep",
  "keeping",
  "caches",
  "caching",
  "cached",
  "stores",
  "store",
  "storing",
  "stored",
  "compute",
  "layer",
  "layers",
  "runs",
  "finishes",
  "uses",
  "use",
  "using",
  "hang",
  "off",
  "where",
  "which",
  "when",
  "also",
  "just",
  "then",
]);

/**
 * Ordinary clause words. They are not product brands, even when a sentence capitalizes them.
 * "talks" must not replace Authorization Server. "tigris" is not in this set.
 */
const ORDINARY = new Set([
  "talks",
  "talk",
  "talked",
  "talking",
  "checks",
  "check",
  "checked",
  "checking",
  "hosts",
  "hosted",
  "holds",
  "hold",
  "holding",
  "later",
  "earlier",
  "afterward",
  "afterwards",
  "token",
  "tokens",
  "access",
  "named",
  "called",
  "sits",
  "sit",
  "sitting",
  ...PLACEMENT_MANNER_TOKENS,
  "verifies",
  "verify",
  "verified",
  "validates",
  "validate",
  "validated",
  "beside",
  "besides",
]);

/** Adjectives that belong to the product name. "Managed Redis" is not the brand Managed. */
const MODIFIER = new Set([
  "managed",
  "elastic",
  "dedicated",
  "shared",
  "private",
  "public",
  "global",
  "regional",
  "serverless",
  "distributed",
  "relational",
  "primary",
  "secondary",
  "internal",
  "external",
  "standard",
  "premium",
  "enterprise",
  "container",
  "digital",
  "native",
  "virtual",
  "general",
  "automatic",
  "autonomous",
  "hosted",
]);

const NAME_FILLER = new Set(["box", "boxes", "shape", "shapes", "node", "nodes", "component", "components", "thing", "things"]);

function tierToken(token: string): boolean {
  return /^(?:\d+|two|three|four|five)[\s-]*tier$/.test(token);
}

function rejectedToken(token: string): boolean {
  return (
    FLUFF.has(token) ||
    GLOSS.has(token) ||
    CUE.has(token) ||
    HARD_CUE.has(token) ||
    MODIFIERS.has(token) ||
    CRUMB.has(token) ||
    TITLE_WORD.has(token) ||
    tierToken(token) ||
    /^\d+$/.test(token)
  );
}

/**
 * An uncommon brand. Lowercase tokens count only beside a role phrase
 * ("tigris" next to object storage). Ordinary words do not.
 */
function isUncommonBrand(token: string, segment: string, allowLowercase = false): boolean {
  if (rejectedToken(token) || ORDINARY.has(token)) return false;
  // "Vercel" and "Orders" are products even when the word also appears inside a role phrase.
  const roleWord = ROLE_WORDS.has(token);
  if (roleWord && !looksNamed(token, segment) && !token.includes(".") && !/\d/.test(token)) return false;
  if (token.includes(".") || /\d/.test(token)) return true;
  if (token.length < 3) return false;
  if (looksNamed(token, segment)) return true;
  return allowLowercase && !roleWord && token.length >= 4;
}

interface SegmentPiece {
  label: string;
  role: EntityRole;
  order: number;
}

/** Proper names in a clause. Style, grammar, and bare gloss do not become boxes. */
function nodesFromSegment(segment: { start: number; text: string }): SegmentPiece[] {
  const items: Array<{ token: string; raw: string; index: number }> = [];
  for (const match of segment.text.matchAll(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g)) {
    const token = match[0].toLowerCase();
    if (
      FLUFF.has(token) ||
      CUE.has(token) ||
      HARD_CUE.has(token) ||
      MODIFIERS.has(token) ||
      CRUMB.has(token) ||
      TITLE_WORD.has(token) ||
      tierToken(token)
    ) {
      continue;
    }
    if (/^\d+$/.test(token)) continue;
    items.push({ token, raw: match[0], index: match.index ?? 0 });
  }
  const brands = items.filter((item) => isUncommonBrand(item.token, segment.text));
  if (brands.length >= 2) {
    return brands.map((brand) => ({
      label: displayToken(brand.raw),
      role: inferRole(brand.token),
      order: segment.start + brand.index,
    }));
  }
  if (brands.length === 1) {
    const brand = brands[0]!;
    const beside = items.filter((item) => BESIDE.has(item.token));
    if (TITLE_VENDOR.has(brand.token) && beside.length === 0) return [];
    const label = [brand.raw, ...beside.map((item) => item.raw)].map((word) => displayToken(word)).join(" ");
    return [{ label, role: inferRole(label), order: segment.start + brand.index }];
  }
  if (items.length === 1 && items[0] && BESIDE.has(items[0].token)) {
    const only = items[0];
    return [{ label: displayToken(only.raw), role: inferRole(only.token), order: segment.start + only.index }];
  }
  const named = items.filter(
    (item) => looksNamed(item.token, segment.text) && !GLOSS.has(item.token) && !ROLE_WORDS.has(item.token) && !FLUFF.has(item.token),
  );
  if (named.length === 0 || named.length > 3) return [];
  const label = named.map((item) => displayToken(item.raw)).join(" ");
  if (label.length < 2) return [];
  return [{ label, role: inferRole(label), order: segment.start + (named[0]?.index ?? 0) }];
}

function junkLabel(label: string): boolean {
  const words = label.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.every((word) => FLUFF.has(word))) return true;
  return words.every((word) => FLUFF.has(word) || (GLOSS.has(word) && !BESIDE.has(word)));
}

const BRAND_WINDOW = 4;

function isBrandToken(token: string, segment: string): boolean {
  // "Client" beside Postgres is another service, not a brand that renames it.
  // Dotted or numbered tokens (Fly.io, Next.js) can still replace a role phrase.
  if (ROLE_WORDS.has(token) && !token.includes(".") && !/\d/.test(token)) return false;
  return isUncommonBrand(token, segment, true);
}

function nearestBrand(tokens: string[], segment: string, fromEnd: boolean): { token: string; dist: number } | null {
  if (fromEnd) {
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = tokens[index] ?? "";
      if (!isBrandToken(token, segment)) continue;
      return { token, dist: tokens.length - 1 - index };
    }
    return null;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!isBrandToken(token, segment)) continue;
    return { token, dist: index };
  }
  return null;
}

/**
 * The brand sitting next to a role phrase. "blobs in Tigris" keeps Tigris.
 * A farther name in the same sentence ("Fly.io … blobs in Tigris") stays its own node.
 * Glue such as "hang off" is not a brand.
 */
function brandsBeside(
  segment: { start: number; text: string },
  span: Span,
  neighbors: Span[],
): string[] {
  const relStart = span.start - segment.start;
  const relEnd = span.end - segment.start;
  let leftCut = 0;
  let rightCut = segment.text.length;
  for (const other of neighbors) {
    if (other === span) continue;
    const start = other.start - segment.start;
    const end = other.end - segment.start;
    if (end <= relStart && end > leftCut) leftCut = end;
    if (start >= relEnd && start < rightCut) rightCut = start;
  }
  const before = wordsOf(segment.text.slice(leftCut, Math.max(leftCut, relStart)));
  const after = wordsOf(segment.text.slice(relEnd, rightCut));
  // "app servers handling business rules" — words after the product describe it.
  // "Tigris for object storage" keeps the brand on the other side of the phrase.
  const purposeAt = after.findIndex((token) => /^(?:handling|handles|handle|for|as)$/.test(token));
  const afterBrand = purposeAt === -1 ? after : after.slice(0, purposeAt);
  const left = nearestBrand(before, segment.text, true);
  const right = nearestBrand(afterBrand, segment.text, false);
  const leftOk = Boolean(left && left.dist <= BRAND_WINDOW);
  const rightOk = Boolean(right && right.dist <= BRAND_WINDOW);
  if (leftOk && rightOk && left && right) return left.dist <= right.dist ? [left.token] : [right.token];
  if (leftOk && left) return [left.token];
  if (rightOk && right) return [right.token];
  return [];
}

/** A capitalized listed stage ("Build") sharing a clause with another product. */
function listedExtras(
  segment: { start: number; text: string },
  fullText: string,
  blocked: Set<string>,
): Array<{ entry: CatalogEntry; order: number }> {
  const hay = segment.text.toLowerCase();
  const found: Array<{ entry: CatalogEntry; order: number }> = [];
  for (const hit of LISTED) {
    // Only stages (Build, Test, Deploy). A capitalized title word such as "Web" or "App"
    // shares the clause and must not become its own vertex.
    if (hit.entry.role !== "step") continue;
    if (hit.entry.when && !hit.entry.when(fullText)) continue;
    let from = 0;
    while (from < hay.length) {
      const at = hay.indexOf(hit.phrase, from);
      if (at === -1) break;
      const end = at + hit.phrase.length;
      from = at + Math.max(1, hit.phrase.length);
      if (!bounded(hay, at, end)) continue;
      const tokens = hit.phrase.split(/\s+/);
      if (tokens.some((token) => blocked.has(token))) continue;
      const raw = segment.text.slice(at, end);
      if (!/^[A-Z0-9]/.test(raw)) continue;
      found.push({ entry: hit.entry, order: segment.start + at });
      for (const token of tokens) blocked.add(token);
    }
  }
  return found;
}

function looseNames(
  segment: { start: number; text: string },
  used: Set<string>,
): Array<{ label: string; order: number }> {
  const found: Array<{ label: string; order: number }> = [];
  for (const match of segment.text.matchAll(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g)) {
    const token = match[0].toLowerCase();
    if (used.has(token) || rejectedToken(token) || FLUFF.has(token)) continue;
    if (!isUncommonBrand(token, segment.text)) continue;
    found.push({
      label: titleLabel([token]),
      order: segment.start + (match.index ?? 0),
    });
  }
  return found;
}

/** Role of one named tier in an architecture chain. Redis and a gateway stay in their topic group. */
export function chainRole(label: string): EntityRole {
  const text = label.toLowerCase();
  if (/\b(redis|memcached|cache)\b/.test(text)) return "data";
  if (/\b(browser|client|frontend|shopper)\b/.test(text)) return "client";
  if (/\b(user|actor|customer|admin)\b/.test(text)) return "actor";
  if (/\b(gateway|balancer|cdn|proxy|cloudfront)\b/.test(text)) return "edge";
  return inferRole(label);
}

export function topicLabelFor(role: EntityRole): string {
  return GROUP_LABEL[role];
}

/** Label on the edge between two named tiers. Same words the layered stacks use. */
export function chainEdgeLabel(fromLabel: string, toLabel: string): string {
  return linkLabel(
    { role: chainRole(fromLabel), label: fromLabel } as NamedEntity,
    { role: chainRole(toLabel), label: toLabel } as NamedEntity,
  );
}

function inferRole(label: string): EntityRole {
  const text = label.toLowerCase();
  if (/\b(database|postgres|mysql|mongo|cosmos|dynamo|sql|db|d1|elasticsearch|opensearch)\b/.test(text)) return "data";
  if (/\b(storage|bucket|blob|s3|r2)\b/.test(text)) return "storage";
  if (/\b(queue|queues|bus|kafka|sqs|sns|hub|pubsub)\b/.test(text)) return "bus";
  if (/\b(gateway|apim|balancer|cloudfront|cdn|waf)\b/.test(text)) return "edge";
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

/** Same pastel a named-entity stack uses for this role. Templates share it instead of flat white. */
export function rolePaint(role: EntityRole, index: number): { fill: string; stroke: string } {
  return pastel(role, index);
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

function displayToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length > 1 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) return trimmed;
  if (/[A-Z]/.test(trimmed.slice(1))) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

interface Compound {
  start: number;
  end: number;
  words: string[];
  rawWords: string[];
}

/** Consecutive capitalized words are one product token. "App Platform", "Managed Redis". */
function compoundsIn(text: string): Compound[] {
  const found: Compound[] = [];
  const pattern = /\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)+\b/g;
  for (const match of text.matchAll(pattern)) {
    const rawWords = match[0].split(/\s+/);
    const words = rawWords.map((word) => word.toLowerCase());
    if (words.length < 2) continue;
    const head = words[0] ?? "";
    // "Draw Fly" is a verb plus a name. "App Platform" keeps the role word that is part of the product.
    if ((CUE.has(head) || HARD_CUE.has(head) || ORDINARY.has(head)) && !ROLE_WORDS.has(head) && !MODIFIER.has(head)) {
      continue;
    }
    if (words.every((word) => ORDINARY.has(word) || (rejectedToken(word) && !ROLE_WORDS.has(word)))) continue;
    found.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      words,
      rawWords,
    });
  }
  return found;
}

function roleish(word: string): boolean {
  if (ROLE_WORDS.has(word)) return true;
  if (word.length > 3 && word.endsWith("s") && ROLE_WORDS.has(word.slice(0, -1))) return true;
  return false;
}

function headIsUncommon(word: string): boolean {
  return (
    !ROLE_WORDS.has(word) &&
    !CUE.has(word) &&
    !HARD_CUE.has(word) &&
    !MODIFIER.has(word) &&
    !GLOSS.has(word) &&
    !MODIFIERS.has(word) &&
    !FLUFF.has(word) &&
    !ORDINARY.has(word) &&
    !CRUMB.has(word) &&
    !NAME_FILLER.has(word)
  );
}

function phraseEntry(phrase: string, text: string): CatalogEntry | null {
  const key = phrase.toLowerCase();
  for (const entry of CATALOG) {
    if (entry.when && !entry.when(text)) continue;
    if (entry.phrases.some((item) => item.toLowerCase() === key)) return entry;
  }
  return null;
}

function compoundDraft(compound: Compound, span: Span | null, text: string): Draft | null {
  const phrase = compound.words.join(" ");
  const exact = phraseEntry(phrase, text) ?? (span && span.entry.phrases.some((item) => item.toLowerCase() === phrase) ? span.entry : null);
  if (exact) {
    return {
      id: exact.id,
      label: exact.label,
      role: exact.role,
      shape: shapeFor(exact, exact.label),
      order: compound.start,
      origin: "catalog",
    };
  }
  const head = compound.words[0] ?? "";
  const tail = compound.words.slice(1).join(" ");
  const tailEntry = span && span.entry.phrases.some((item) => item.toLowerCase() === tail) ? span.entry : phraseEntry(tail, text);
  // "Upstash Redis" is the brand Upstash. "Managed Redis" keeps both words.
  // A listed stage ("Smoke Test") is not a role word to strip.
  if (tailEntry && !tailEntry.listed && tailEntry.role !== "step" && headIsUncommon(head)) {
    const label = displayToken(compound.rawWords[0] ?? head);
    return {
      id: label.toLowerCase(),
      label,
      role: tailEntry.role,
      shape: shapeFor(tailEntry, label),
      order: compound.start,
      origin: "adhoc",
    };
  }
  const label = compound.rawWords.map((word) => displayToken(word)).join(" ");
  if (junkLabel(label)) return null;
  const role = tailEntry?.role ?? span?.entry.role ?? inferRole(label);
  return {
    id: label.toLowerCase(),
    label,
    role,
    shape: shapeFor(tailEntry ?? span?.entry ?? { role }, label),
    order: compound.start,
    origin: "adhoc",
  };
}

function overlappingSpan(compound: Compound, spans: Span[]): Span | null {
  const hits = spans.filter((span) => span.start < compound.end && compound.start < span.end);
  hits.sort((left, right) => right.end - right.start - (left.end - left.start));
  return hits[0] ?? null;
}

/** "client browser" is one actor. "web app" is two roles and stays split. Plurals ("browser clients") stay split. */
function listedActorPair(left: string, right: string, text: string): boolean {
  const leftEntry = phraseEntry(left, text);
  const rightEntry = phraseEntry(right, text);
  if (!leftEntry?.listed || !rightEntry?.listed || leftEntry.id === rightEntry.id) return false;
  if (leftEntry.role !== rightEntry.role) return false;
  return leftEntry.role === "client" || leftEntry.role === "actor";
}

/**
 * A cue or modifier stuck to the next word is one name.
 * "app platform" must not become Platform. "managed redis" must not drop Redis.
 * An uncommon brand still replaces its role word ("upstash redis" → Upstash).
 */
function salvageBigrams(
  segment: { start: number; end: number; text: string },
  spans: Span[],
  blocked: Set<string>,
  consumed: Set<Span>,
  text: string,
): Draft[] {
  const drafts: Draft[] = [];
  const matches = [...segment.text.matchAll(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g)];
  for (let index = 0; index < matches.length - 1; index += 1) {
    const first = matches[index];
    const second = matches[index + 1];
    if (!first || !second || first.index === undefined || second.index === undefined) continue;
    const gap = segment.text.slice(first.index + first[0].length, second.index);
    if (!/^\s+$/.test(gap)) continue;
    const left = first[0].toLowerCase();
    const right = second[0].toLowerCase();
    if (blocked.has(left) || blocked.has(right)) continue;
    if (ORDINARY.has(left) || ORDINARY.has(right) || NAME_FILLER.has(right)) continue;
    // "app requests" is a verb, not a product. "app platform" still joins.
    if (/^(?:requests?|sends?|checks?|calls?|asks?|verifies?|validates?|talks?|speaks?|runs?|holds?|keeps?|stores?)$/.test(right)) {
      continue;
    }
    if (MODIFIERS.has(left) || /^(?:a|an|the)$/.test(left)) continue;
    // "managed redis" keeps the product. "app platform" keeps the cue that would be stripped.
    // "web app" and "redis cache" are two role words and stay on the catalog path.
    // "client browser" is one actor: two listed people-side nouns of the same role.
    const leftIsModifier = MODIFIER.has(left) && !roleish(left);
    const rightIsRole = roleish(right) || Boolean(phraseEntry(right, text));
    // Only a role word that would be stripped ("app" in "app platform"), not a verb ("draw", "and").
    const leftIsFragment = roleish(left) && !rightIsRole;
    const actorPair = listedActorPair(left, right, text);
    if (!leftIsModifier && !leftIsFragment && !actorPair) continue;
    if (headIsUncommon(left)) continue;
    if (rejectedToken(right) && !ROLE_WORDS.has(right)) continue;
    const start = segment.start + first.index;
    const end = segment.start + second.index + second[0].length;
    // "app servers handling business rules" already named the tier. "business rules"
    // on its own is still that tier.
    if (leftIsFragment && !actorPair) {
      const before = segment.text.slice(0, first.index);
      const purpose = /\b(?:handling|handles|handle|for|as)\s+$/i.test(before);
      const namesAProduct = spans.some(
        (span) => segment.start <= span.start && span.end <= segment.end && (span.end <= start || span.start >= end),
      );
      if (purpose && namesAProduct) continue;
    }
    const compound: Compound = {
      start,
      end,
      words: [left, right],
      rawWords: [first[0], second[0]],
    };
    const span = overlappingSpan(compound, spans);
    if (span && (span.start < compound.start || span.end > compound.end)) continue;
    const draft = compoundDraft(compound, span, text);
    if (!draft) continue;
    if (span) consumed.add(span);
    blocked.add(left);
    blocked.add(right);
    drafts.push(draft);
  }
  return drafts;
}

/** A drawing verb at the start of the request is not a tier. "Outline a stack" is not a node named Outline. */
const DRAWING_VERBS = new Set(["outline", "outlining", "outlined", "depict", "depicting", "chart", "trace", "render", "rendering"]);

const DIAGRAM_KIND = new Set([
  "sequence",
  "choreography",
  "choreograph",
  "signin",
  "sign-in",
  "login",
  "log-in",
  "flow",
  "flowchart",
  "diagram",
  "sketch",
  "path",
  "stack",
  "pipeline",
  "architecture",
  "layout",
  "workflow",
  "process",
  "journey",
]);

function leadingImperative(label: string, text: string): boolean {
  if (label.includes(" ")) return false;
  const word = label.toLowerCase();
  if (!DRAWING_VERBS.has(word)) return false;
  const hay = text.toLowerCase();
  const at = hay.indexOf(word);
  if (at < 0) return false;
  const before = hay.slice(0, at).trim();
  if (before && !/^(?:please|kindly)$/.test(before)) return false;
  const after = hay.slice(at + word.length);
  return /^\s+(?:me\s+)?(?:a|an|the|our|my|this|these|those|\d+|two|three|four|five)\b/.test(after);
}

/** "Careful sketch" / "Passwordless sign-in" — an adjective glued to the diagram kind is not a service. */
function diagramAdjective(label: string, text: string): boolean {
  const parts = label.toLowerCase().split(/\s+/);
  if (parts.length !== 1) return false;
  const word = parts[0] ?? "";
  if (!/(?:less|ful)$/.test(word)) return false;
  const hay = text.toLowerCase();
  const at = hay.indexOf(word);
  if (at < 0) return false;
  const next = hay.slice(at + word.length).match(/^\s+([a-z0-9]+(?:-[a-z0-9]+)*)/);
  return DIAGRAM_KIND.has(next?.[1] ?? "");
}

/**
 * The clause that lists steps.
 * A process, workflow, or procedure with a separator needs two steps.
 * A flow, flowchart, path, journey, or "listing" needs four, so a short aside is not a procedure.
 */
function processListBody(text: string): { body: string; minimum: number } | null {
  const listing = text.match(/\blisting\b\s+/i);
  if (
    listing &&
    listing.index !== undefined &&
    /\b(?:flowchart|flow\s*chart|workflows?|process|procedure|pipelines?|flow|path|journey)\b/i.test(text)
  ) {
    return { body: text.slice(listing.index + listing[0].length), minimum: 4 };
  }
  const strict = text.match(/\b(?:process|workflow|procedure)\b\s*[:,—–-]\s*/i);
  if (strict && strict.index !== undefined) {
    return { body: text.slice(strict.index + strict[0].length), minimum: 2 };
  }
  const headed = text.match(
    /\b(?:flowchart|flow\s*chart|workflows?|process|procedure|pipelines?|flow|path|journey)\b[^:]{0,80}:\s*/i,
  );
  if (headed && headed.index !== undefined) {
    const strictCue = /\b(?:process|workflow|procedure)\b/i.test(headed[0]);
    return { body: text.slice(headed.index + headed[0].length), minimum: strictCue ? 2 : 4 };
  }
  return null;
}

/**
 * Comma-separated steps after a process, workflow, path, journey, flow, or "listing".
 * A list that already names catalog services stays on that path.
 * Four or more named steps stay one vertex each. "to" inside a step is not a chain break.
 */
export function listedProcessSteps(message: string): string[] | null {
  const text = normalize(message);
  const found = processListBody(text);
  if (!found) return null;
  const body = found.body;
  const parts = body
    .split(/\s*(?:,|;)\s*|\s+\bthen\b\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const steps: string[] = [];
  for (const part of parts) {
    if (catalogSpans(part).length > 0) return null;
    if (compoundsIn(part).some((compound) => headIsUncommon(compound.words[0] ?? ""))) return null;
    const rawWords = part
      .replace(/[?.!]+$/g, "")
      .trim()
      .split(/\s+/)
      .filter((word) => word && !/^(?:a|an|the|and|then)$/i.test(word));
    if (rawWords.length === 0 || rawWords.length > 8) return null;
    if (rawWords.every((word) => rejectedToken(word.toLowerCase()) || ORDINARY.has(word.toLowerCase()))) continue;
    steps.push(rawWords.map((word) => displayToken(word)).join(" "));
  }
  return steps.length >= found.minimum ? steps : null;
}

/**
 * Role nouns a tier list can name without being a product catalog hit.
 * Plurals ("clients", "browsers") count as the same role. A counted tier
 * ("3 tier", "three-tier") is a title, not one of these nouns.
 */
const TIER_ROLE: Record<string, EntityRole> = {
  browser: "client",
  client: "client",
  frontend: "client",
  "front-end": "client",
  presentation: "client",
  ui: "client",
  web: "client",
  app: "compute",
  application: "compute",
  backend: "compute",
  "back-end": "compute",
  service: "compute",
  server: "compute",
  api: "compute",
  database: "data",
  db: "data",
  sql: "data",
  datastore: "data",
  "data-store": "data",
  data: "data",
};

const TIER_GLUE = new Set(["tier", "tiers", "layer", "layers", "level", "levels"]);

function tierRole(token: string): EntityRole | null {
  const direct = TIER_ROLE[token];
  if (direct) return direct;
  if (token.length >= 4 && token.endsWith("s")) {
    const stem = TIER_ROLE[token.slice(0, -1)];
    if (stem) return stem;
  }
  if (token.length >= 5 && token.endsWith("es")) {
    const stem = TIER_ROLE[token.slice(0, -2)];
    if (stem) return stem;
  }
  return null;
}

function listedTierEntry(token: string): CatalogEntry | null {
  const candidates = [token];
  if (token.length >= 4 && token.endsWith("s")) candidates.push(token.slice(0, -1));
  if (token.length >= 5 && token.endsWith("es")) candidates.push(token.slice(0, -2));
  for (const candidate of candidates) {
    for (const entry of CATALOG) {
      if (!entry.listed) continue;
      if (entry.when) continue;
      if (entry.phrases.some((phrase) => phrase.toLowerCase() === candidate)) return entry;
    }
  }
  return null;
}

function tierDraftFor(raw: string, token: string, order: number): Draft {
  const entry = listedTierEntry(token);
  const role = entry?.role ?? tierRole(token) ?? "compute";
  if (entry) {
    return {
      id: entry.id,
      label: entry.label,
      role: entry.role,
      shape: shapeFor(entry, entry.label),
      order,
      origin: "listed",
    };
  }
  const label = displayToken(raw);
  return {
    id: label.toLowerCase(),
    label,
    role,
    shape: shapeFor({ role }, label),
    order,
    origin: "listed",
  };
}

/**
 * A short list item that only names roles.
 * "browser clients" is one client tier. "web app" is two roles and stays split.
 * "clients" is the same vertex as "client". A title ("3 tier web app") is not a tier.
 */
function draftsFromTierPhrase(
  segment: { start: number; text: string },
  blocked: Set<string>,
): Draft[] | null {
  const stripped = segment.text
    .replace(
      /^(?:please\s+)?(?:draw|sketch|diagram|illustrate|map|build|create|architect|show)\s+(?:me\s+)?(?:a|an|the\s+)?/i,
      "",
    )
    .replace(/^(?:and|then|plus)\s+/i, "");
  if (/\b(?:\d+|two|three|four|five)[\s-]*tier\b/i.test(stripped)) return null;
  const rawWords = stripped.match(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g) ?? [];
  if (rawWords.length === 0 || rawWords.length > 4) return null;
  const kept: Array<{ raw: string; token: string; role: EntityRole }> = [];
  for (const raw of rawWords) {
    const token = raw.toLowerCase();
    if (/^(?:a|an|the)$/.test(token) || TIER_GLUE.has(token)) continue;
    const role = tierRole(token);
    if (!role) return null;
    if (blocked.has(token)) return null;
    kept.push({ raw, token, role });
  }
  if (kept.length === 0) return null;
  const roles = new Set(kept.map((item) => item.role));
  if (roles.size === 1) {
    const only = kept[0];
    if (kept.length === 1 && only) return [tierDraftFor(only.raw, only.token, segment.start)];
    const label = kept.map((item) => displayToken(item.raw)).join(" ");
    const role = kept[0]?.role ?? "compute";
    const shaped = kept
      .map((item) => listedTierEntry(item.token))
      .find((entry) => entry?.shape || entry?.role === "data");
    return [
      {
        id: label.toLowerCase(),
        label,
        role,
        shape: shaped ? shapeFor(shaped, label) : shapeFor({ role }, label),
        order: segment.start,
        origin: "adhoc",
      },
    ];
  }
  return kept.map((item) => tierDraftFor(item.raw, item.token, segment.start));
}

/** "Sql" or "Object storage" beside a real product of that role is the role, not another vertex. */
function dropCoveredRoleGloss(drafts: Draft[]): Draft[] {
  const generic = /^(?:sql|object storage|object store|data|data layer)$/i;
  return drafts.filter((draft) => {
    if (!generic.test(draft.label)) return true;
    return !drafts.some((other) => other !== draft && other.role === draft.role && !generic.test(other.label));
  });
}

/** Concrete services, steps, actors, and states named in the message. */
export function extractNamedEntities(message: string): NamedEntity[] {
  const text = normalize(message);
  if (!text) return [];
  const spans = catalogSpans(text);
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  const consumed = new Set<Span>();

  function pushDraft(draft: Draft) {
    if (draft.origin === "adhoc" && (junkLabel(draft.label) || leadingImperative(draft.label, text) || diagramAdjective(draft.label, text))) {
      return;
    }
    const key = draft.origin === "catalog" ? draft.id : draft.label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push(draft);
  }

  const steps = listedProcessSteps(text);
  if (steps) {
    steps.forEach((label, index) => {
      pushDraft({
        id: label.toLowerCase(),
        label,
        role: "step",
        shape: "rectangle",
        order: index,
        origin: "listed",
      });
    });
  }

  if (!steps) for (const segment of segmentsOf(text)) {
    const overlapping = spans.filter((span) => span.start < segment.end && segment.start < span.end);
    const blocked = new Set<string>();
    for (const local of compoundsIn(segment.text)) {
      const compound: Compound = {
        ...local,
        start: segment.start + local.start,
        end: segment.start + local.end,
      };
      const span = overlappingSpan(compound, overlapping.filter((item) => !consumed.has(item)));
      const draft = compoundDraft(compound, span, text);
      if (!draft) continue;
      if (span) consumed.add(span);
      for (const word of compound.words) blocked.add(word);
      pushDraft({ ...draft, order: compound.start });
    }
    for (const draft of salvageBigrams(segment, overlapping, blocked, consumed, text)) {
      pushDraft(draft);
    }
    if (overlapping.length > 0) {
      // A slash splits "Pub/Sub" into two segments. Only the segment that holds the whole phrase owns it.
      const owned = overlapping.filter(
        (span) => !consumed.has(span) && segment.start <= span.start && segment.end >= span.end,
      );
      if (owned.length > 0) {
        const used = new Set<string>(blocked);
        for (const span of owned) {
          consumed.add(span);
          for (const token of wordsOf(text.slice(span.start, span.end))) used.add(token);
          const brand = brandsBeside(segment, span, owned).filter((token) => !blocked.has(token));
          for (const token of brand) used.add(token);
          const modifier = brand.length === 1 && brand[0] && MODIFIER.has(brand[0]) ? brand[0] : null;
          const branded = brand.length > 0 && !modifier;
          const label = modifier
            ? `${displayToken(modifier)} ${span.entry.label}`
            : branded
              ? titleLabel(brand)
              : span.entry.label;
          const brandAt = brand[0] ? segment.text.toLowerCase().indexOf(brand[0]) : -1;
          pushDraft({
            id: modifier || branded ? label.toLowerCase() : span.entry.id,
            label,
            role: span.entry.role,
            shape: shapeFor(span.entry, label),
            order: brandAt >= 0 ? segment.start + brandAt : span.start,
            origin: modifier || branded ? "adhoc" : "catalog",
          });
        }
        for (const extra of listedExtras(segment, text, used)) {
          pushDraft({
            id: extra.entry.id,
            label: extra.entry.label,
            role: extra.entry.role,
            shape: shapeFor(extra.entry, extra.entry.label),
            order: extra.order,
            origin: "listed",
          });
        }
        for (const extra of looseNames(segment, used)) {
          pushDraft({
            id: extra.label.toLowerCase(),
            label: extra.label,
            role: inferRole(extra.label),
            shape: shapeFor({ role: inferRole(extra.label) }, extra.label),
            order: extra.order,
            origin: "adhoc",
          });
        }
      }
      continue;
    }
    const listed = listedEntry(segment.text, text);
    if (listed && !blocked.has(listed.label.toLowerCase())) {
      pushDraft({
        id: listed.id,
        label: listed.label,
        role: listed.role,
        shape: shapeFor(listed, listed.label),
        order: segment.start,
        origin: "listed",
      });
      continue;
    }
    const tierDrafts = draftsFromTierPhrase(segment, blocked);
    if (tierDrafts) {
      for (const draft of tierDrafts) pushDraft(draft);
      continue;
    }
    for (const extra of nodesFromSegment(segment)) {
      const words = extra.label.toLowerCase().split(/\s+/);
      if (words.every((word) => blocked.has(word))) continue;
      pushDraft({
        id: extra.label.toLowerCase(),
        label: extra.label,
        role: extra.role,
        shape: shapeFor({ role: extra.role }, extra.label),
        order: extra.order,
        origin: "adhoc",
      });
    }
  }

  for (const span of spans) {
    if (consumed.has(span)) continue;
    pushDraft({
      id: span.entry.id,
      label: span.entry.label,
      role: span.entry.role,
      shape: shapeFor(span.entry, span.entry.label),
      order: span.start,
      origin: "catalog",
    });
  }

  const kept = dropCoveredRoleGloss(drafts);
  drafts.length = 0;
  drafts.push(...kept);
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

/** Parent→child, adjacent tiers, or a step chain. Never a cross-product of every pair. */
export function maxSparseEdges(nodeCount: number): number {
  return Math.max(nodeCount - 1, 1) * 2;
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

  const steps = byRole.get("step") ?? [];
  for (let index = 1; index < steps.length; index += 1) {
    const from = steps[index - 1];
    const to = steps[index];
    if (from && to) pushEdge(edges, from, to);
  }

  let previous: NamedEntity[] = [];
  for (const role of present) {
    const current = byRole.get(role) ?? [];
    if (role === "step" && current.length > 1) {
      const head = current[0];
      const tail = current[current.length - 1];
      if (head) connectTiers(previous, [head], edges);
      previous = tail ? [tail] : [];
      continue;
    }
    connectTiers(previous, current, edges);
    previous = current;
  }

  const cap = maxSparseEdges(nodes.length);
  return edges.length > cap ? edges.slice(0, cap) : edges;
}

function topicTitle(text: string): string | null {
  if (/\bcloudflare\b/i.test(text)) return "Cloudflare";
  if (/\bazure\b/i.test(text)) return "Azure";
  if (/\b(aws|amazon)\b/i.test(text)) return "AWS";
  if (/\bstripe\b/i.test(text)) return "Stripe";
  if (/\b(gcp|google cloud)\b/i.test(text)) return "GCP";
  if (/\bmicroservice/i.test(text)) return "Microservices";
  if (/\bsequence\b/i.test(text)) return "Sequence";
  const heading = text.match(/^(.*?)\b(?:process|workflow|procedure|journey|path|flow)\b/i);
  if (heading?.[1]) {
    const words = (heading[1].match(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g) ?? []).filter((word) => {
      const key = word.toLowerCase();
      return !rejectedToken(key) && !ORDINARY.has(key) && !NAME_FILLER.has(key);
    });
    if (words.length >= 1 && words.length <= 6) return words.map((word) => displayToken(word)).join(" ");
  }
  return null;
}

const MESSAGE_VERB =
  /\b(requests?|sends?|checks?|calls?|asks?|verifies?|validates?|returns?|replies|invokes?|queries?|notifies?|issues?|authenticates?|posts?|talks?|speaks?)\b/i;

const CHECK_VERB = /^(?:checks?|verifies?|validates?|authenticates?)$/i;

/** Sign-in, login, choreography, or sequence language plus a message verb. */
function isExchange(text: string): boolean {
  const kind = /\b(?:sequence|choreograph\w*|sign[\s-]?in|log[\s-]?in)\b/i.test(text);
  return kind && MESSAGE_VERB.test(text);
}

function nodesInClause(clause: string, nodes: NamedEntity[]): NamedEntity[] {
  const hay = clause.toLowerCase();
  const hits: Array<{ node: NamedEntity; at: number; end: number }> = [];
  for (const node of nodes) {
    const needle = node.label.toLowerCase();
    let from = 0;
    while (from < hay.length) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      const end = at + needle.length;
      from = end;
      if (!bounded(hay, at, end)) continue;
      hits.push({ node, at, end });
      break;
    }
  }
  hits.sort((left, right) => left.at - right.at || right.end - right.at - (left.end - left.at));
  const kept: Array<{ node: NamedEntity; at: number; end: number }> = [];
  for (const hit of hits) {
    if (kept.some((other) => other.at <= hit.at && other.end >= hit.end && other.end - other.at > hit.end - hit.at)) continue;
    kept.push(hit);
  }
  return kept.map((hit) => hit.node);
}

function verbStem(verb: string): string {
  const lower = verb.toLowerCase();
  if (/^requests?$/.test(lower)) return "Request";
  if (/^checks?$/.test(lower)) return "Check";
  if (/^talks?$/.test(lower)) return "Talk";
  if (/^speaks?$/.test(lower)) return "Speak";
  if (/^sends?$/.test(lower)) return "Send";
  if (/^calls?$/.test(lower)) return "Call";
  if (/^asks?$/.test(lower)) return "Ask";
  if (/^verif/.test(lower)) return "Verify";
  if (/^validat/.test(lower)) return "Validate";
  if (/^authentica/.test(lower)) return "Authenticate";
  if (/^notifies?$/.test(lower)) return "Notify";
  if (/^invokes?$/.test(lower)) return "Invoke";
  if (/^queries?$/.test(lower)) return "Query";
  if (/^returns?$/.test(lower)) return "Return";
  if (/^replies?$/.test(lower)) return "Reply";
  if (/^issues?$/.test(lower)) return "Issue";
  if (/^posts?$/.test(lower)) return "Post";
  return displayToken(lower);
}

function messageObject(clause: string, verb: RegExpMatchArray, mentioned: NamedEntity[]): string {
  const start = (verb.index ?? 0) + verb[0].length;
  let rest = clause.slice(start);
  const stop = rest.search(/\b(?:from|to|into|onto|via|using|with|for|by|and|then)\b/i);
  if (stop >= 0) rest = rest.slice(0, stop);
  const skip = new Set(["a", "an", "the", "its", "their", "his", "her", "this", "that"]);
  const mentionedWords = new Set(mentioned.flatMap((node) => node.label.toLowerCase().split(/\s+/)));
  const words = (rest.match(/[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*/g) ?? []).filter((word) => {
    const key = word.toLowerCase();
    return !skip.has(key) && !mentionedWords.has(key);
  });
  if (words.length === 0) return verbStem(verb[1] ?? verb[0]);
  return words.map((word) => displayToken(word)).join(" ");
}

/** One message per clause that names an actor and a verb. A lone check lands on the previous actor. */
function exchangeMessages(text: string, nodes: NamedEntity[]): Array<{ from: string; to: string; label: string }> {
  const clauses = text
    .split(/\s*(?:;|\.\s+)\s*|\s+\b(?:later|then|afterward|afterwards)\b\s*/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const messages: Array<{ from: string; to: string; label: string }> = [];
  let previous: NamedEntity | null = null;
  for (const clause of clauses) {
    const mentioned = nodesInClause(clause, nodes);
    const verb = clause.match(MESSAGE_VERB);
    if (mentioned.length === 0) continue;
    if (!verb) {
      previous = mentioned[mentioned.length - 1] ?? previous;
      continue;
    }
    const label = messageObject(clause, verb, mentioned);
    if (mentioned.length >= 2) {
      const from = mentioned[0];
      const to = mentioned[mentioned.length - 1];
      if (from && to && from.id !== to.id) messages.push({ from: from.id, to: to.id, label });
      previous = to ?? previous;
      continue;
    }
    const only = mentioned[0];
    if (only && previous && previous.id !== only.id) {
      const inward = CHECK_VERB.test(verb[1] ?? verb[0]);
      messages.push(inward ? { from: previous.id, to: only.id, label } : { from: only.id, to: previous.id, label });
    }
    previous = only ?? previous;
  }
  return messages;
}

function chainInOrder(nodes: NamedEntity[]): DiagramEdge[] {
  const edges: DiagramEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1];
    const to = nodes[index];
    if (!from || !to || from.id === to.id) continue;
    edges.push({ from: from.id, to: to.id, label: "Next" });
  }
  return edges;
}

/** A layered or sequence diagram made only from the entities the user named. */
export function composeNamedDiagram(message: string, entities?: NamedEntity[]): NamedDiagram | null {
  const text = normalize(message);
  const nodes = entities ?? extractNamedEntities(text);
  if (nodes.length < 2) return null;
  const sequence = /\bsequence\b/i.test(text) || isExchange(text);
  const labels = nodes.map((node) => node.label);
  const title = topicTitle(text) ?? (sequence ? "Sequence" : "Architecture");
  const reply = sequence ? `Drew a sequence with ${labels.join(", ")}.` : `Drew ${title} with ${labels.join(", ")}.`;
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
  let edges = layerEdges(nodes);
  // A same-role row has no tier boundary. Ordered stages still need a connector between neighbors.
  if (!sequence && edges.length === 0 && nodes.length >= 2 && /\b(?:first|then|followed by)\b/i.test(text)) {
    edges = chainInOrder(nodes);
  }
  const parsed = sequence ? exchangeMessages(text, nodes) : [];
  const messages =
    parsed.length > 0
      ? parsed
      : nodes.slice(1).map((node, index) => {
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
