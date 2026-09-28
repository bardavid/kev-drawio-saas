import { inferShape, type ShapeKind } from "@/lib/drawio/styles";
import type { CompositionSpec, LayerEdge, LayerGroup, LayerNode, SequenceSpec, WorkflowSpec } from "@/lib/kev/compose";

/**
 * Blank-canvas composition from the names in the prompt.
 * A service catalog classifies shape and topic. It does not match QA sentences.
 * Unknown names in a list are drawn too.
 */

export interface NamedComposition {
  spec: CompositionSpec;
  context: string;
}

type Tier = "client" | "edge" | "compute" | "network" | "messaging" | "data" | "cache" | "storage" | "stage" | "other";

interface NamedItem {
  id: string;
  label: string;
  tier: Tier;
  shape: ShapeKind;
}

interface KnownService {
  re: RegExp;
  label: string;
  tier: Tier;
  shape: ShapeKind;
}

const SMALL = new Set(["a", "an", "the", "to", "of", "for", "and", "on", "in", "via"]);

const SPECIAL: Record<string, string> = {
  api: "API",
  apis: "APIs",
  sql: "SQL",
  db: "DB",
  aws: "AWS",
  gcp: "GCP",
  http: "HTTP",
  https: "HTTPS",
  ui: "UI",
  url: "URL",
  dns: "DNS",
  cdn: "CDN",
  alb: "ALB",
  ecs: "ECS",
  rds: "RDS",
  sqs: "SQS",
  sns: "SNS",
  s3: "S3",
  vpc: "VPC",
  nat: "NAT",
  iam: "IAM",
  vm: "VM",
  go: "Go",
};

/** Longer aliases first. These are service names, not prompt templates. */
const KNOWN: KnownService[] = [
  { re: /\bgithub\s+actions\b/i, label: "GitHub Actions", tier: "stage", shape: "rectangle" },
  { re: /\bapi\s+management\b|\bapim\b/i, label: "API Management", tier: "edge", shape: "hexagon" },
  { re: /\bapplication\s+gateway\b|\bapp\s+gateway\b/i, label: "Application Gateway", tier: "edge", shape: "hexagon" },
  { re: /\bapi[\s-]?gateway\b/i, label: "API Gateway", tier: "edge", shape: "hexagon" },
  { re: /\bapplication\s+load\s+balancer\b|\balb\b/i, label: "ALB", tier: "edge", shape: "hexagon" },
  { re: /\bcloud\s+load\s+balanc\w*\b/i, label: "Cloud Load Balancing", tier: "edge", shape: "hexagon" },
  { re: /\bload\s+balancers?\b/i, label: "Load balancer", tier: "edge", shape: "hexagon" },
  { re: /\bcloud\s*front\b/i, label: "CloudFront", tier: "edge", shape: "rectangle" },
  { re: /\bcloudflare\b/i, label: "Cloudflare", tier: "edge", shape: "rectangle" },
  { re: /\bazure\s+functions\b/i, label: "Azure Functions", tier: "compute", shape: "rectangle" },
  { re: /\bcloud\s+functions\b/i, label: "Cloud Functions", tier: "compute", shape: "rectangle" },
  { re: /\blambda\b/i, label: "Lambda", tier: "compute", shape: "rectangle" },
  { re: /\becs\s+fargate\b|\bfargate\b/i, label: "ECS Fargate", tier: "compute", shape: "rectangle" },
  { re: /\bcloud\s+run\b/i, label: "Cloud Run", tier: "compute", shape: "rectangle" },
  { re: /\bvpc\s+connector\b|\bserverless\s+vpc\s+access\b/i, label: "VPC connector", tier: "network", shape: "rectangle" },
  { re: /\bapp\s+service\b/i, label: "App Service", tier: "compute", shape: "rectangle" },
  { re: /\bdataflow\b/i, label: "Dataflow", tier: "compute", shape: "rectangle" },
  { re: /\becs\b/i, label: "ECS", tier: "compute", shape: "rectangle" },
  { re: /\bsimple\s+queue(?:\s+service)?\b|\bsqs\b/i, label: "SQS", tier: "messaging", shape: "queue" },
  { re: /\bsimple\s+notification(?:\s+service)?\b|\bsns\b/i, label: "SNS", tier: "messaging", shape: "queue" },
  { re: /\bevent\s+hubs?\b/i, label: "Event Hubs", tier: "messaging", shape: "queue" },
  { re: /\bservice\s+bus\b/i, label: "Service Bus", tier: "messaging", shape: "queue" },
  { re: /\bpub\s*\/?\s*sub\b|\bpubsub\b/i, label: "Pub/Sub", tier: "messaging", shape: "queue" },
  { re: /\bkafka\b/i, label: "Kafka", tier: "messaging", shape: "queue" },
  { re: /\bdynamo\s*db\b/i, label: "DynamoDB", tier: "data", shape: "cylinder" },
  { re: /\bcosmos\s*db\b/i, label: "Cosmos DB", tier: "data", shape: "cylinder" },
  { re: /\bbigquery\b/i, label: "BigQuery", tier: "data", shape: "cylinder" },
  { re: /\bcloud\s+sql\b/i, label: "Cloud SQL", tier: "data", shape: "cylinder" },
  { re: /\bazure\s+sql\b/i, label: "Azure SQL", tier: "data", shape: "cylinder" },
  { re: /\bpostgres(?:ql)?\b/i, label: "Postgres", tier: "data", shape: "cylinder" },
  { re: /\belasti\s*cache\b/i, label: "ElastiCache", tier: "cache", shape: "cylinder" },
  { re: /\bmemorystore\b/i, label: "Memorystore", tier: "cache", shape: "cylinder" },
  { re: /\bredis\b/i, label: "Redis", tier: "cache", shape: "cylinder" },
  { re: /\brds\b/i, label: "RDS", tier: "data", shape: "cylinder" },
  { re: /\bsimple\s+storage\s+service\b|\bs3\b/i, label: "S3", tier: "storage", shape: "cloud" },
  { re: /\bauthorization\s+server\b/i, label: "Authorization Server", tier: "other", shape: "rectangle" },
  { re: /\bresource\s+server\b/i, label: "Resource Server", tier: "other", shape: "rectangle" },
  { re: /\bstripe\s+checkout\b/i, label: "Stripe Checkout", tier: "other", shape: "rectangle" },
  { re: /\bwebhook\s+handlers?\b/i, label: "Webhook handler", tier: "other", shape: "rectangle" },
  { re: /\bauth(?:entication)?\s+services?\b/i, label: "Auth Service", tier: "compute", shape: "rectangle" },
];

const SINK = new Set<Tier>(["messaging", "data", "cache", "storage"]);

const CLUSTER: Record<Tier, string> = {
  client: "Clients",
  edge: "Edge",
  compute: "Compute",
  network: "Network",
  messaging: "Messaging",
  data: "Data",
  cache: "Cache",
  storage: "Storage",
  stage: "Pipeline",
  other: "Services",
};

const DRAW = /\b(draw|sketch|diagram|show|illustrate|map|architect)\b/i;

export function composeNamed(message: string): NamedComposition | null {
  const text = message.trim();
  if (!text || !DRAW.test(text)) return null;
  if (isBetweenEdit(text)) return null;

  const items = extractItems(text);
  if (items.length < 2) return null;

  const kind = diagramKind(text, items);
  if (kind === "sequence") return sequenceDiagram(text, items);
  if (kind === "workflow") return workflowDiagram(text, items);
  if (kind === "pipeline") return pipelineDiagram(text, items);
  return layerDiagram(text, items);
}

function isBetweenEdit(text: string): boolean {
  return /^(?:please\s+)?(?:add|insert|place)\b/i.test(text) && /\bbetween\b/i.test(text);
}

function diagramKind(text: string, items: NamedItem[]): "sequence" | "workflow" | "layers" | "pipeline" {
  if (/\bsequence\b/i.test(text)) return "sequence";
  if (/\bdata\s+pipelines?\b/i.test(text)) return "pipeline";
  if (/\b(pipeline|ci\s*\/\s*cd|continuous\s+integration|continuous\s+delivery|workflow|flowchart)\b/i.test(text)) {
    return "workflow";
  }
  if (items.every((item) => item.tier === "stage")) return "workflow";
  return "layers";
}

function extractItems(text: string): NamedItem[] {
  const listed = itemsFromClause(listClause(text));
  const scanned = scanKnown(text);
  if (listed.length >= 2 || (listed.length === 1 && listed[0] && isCatalogName(listed[0].label))) {
    // The user's list is the order. A later sentence can still add a named service.
    return mergeItems([...listed, ...scanned]).slice(0, 8);
  }
  if (scanned.length >= 2) return mergeItems(scanned).slice(0, 8);
  return [];
}

function isCatalogName(label: string): boolean {
  return KNOWN.some((entry) => entry.label.toLowerCase() === label.toLowerCase());
}

function listClause(text: string): string | null {
  const withMatch = text.match(/\b(?:with|using|including|uses|use)\b\s+(.+)$/i);
  if (withMatch?.[1]) return firstSentence(withMatch[1]);
  const colon = text.match(/:\s*([^:]+)$/);
  if (colon?.[1] && /,|\band\b/i.test(colon[1])) return firstSentence(colon[1]);
  return null;
}

function firstSentence(value: string): string {
  const cut = value.search(/\.\s+/);
  return (cut === -1 ? value : value.slice(0, cut)).replace(/[?.!]+$/g, "").trim();
}

function itemsFromClause(clause: string | null): NamedItem[] {
  if (!clause) return [];
  const parts = clause
    .split(/\s*,\s*|\s+\band\b\s+|\s+\bthen\b\s+|\s*(?:→|->|=>|—>|-->)\s*/i)
    .map((part) => part.replace(/^(?:and|then)\s+/i, "").trim())
    .filter(Boolean);
  const items: NamedItem[] = [];
  for (const part of parts) {
    const known = scanKnown(part);
    if (known.length > 0) {
      items.push(...known);
      continue;
    }
    const item = itemFromPhrase(part);
    if (item) items.push(item);
  }
  return items;
}

function itemFromPhrase(phrase: string): NamedItem | null {
  const known = knownInPhrase(phrase);
  if (known) return known;
  const label = titleLabel(stripTail(phrase));
  if (!label || isNoise(label)) return null;
  return stamp(label, classifyFree(label));
}

function stripTail(phrase: string): string {
  return phrase
    .replace(/^(?:a|an|the|some|my|our)\s+/i, "")
    .replace(/\s+\b(?:in|on|for|from|via|using|into|over|under|inside|within)\b[\s\S]*$/i, "")
    .trim();
}

function knownInPhrase(phrase: string): NamedItem | null {
  const cleaned = phrase.replace(/^(?:a|an|the|some)\s+/i, "").trim();
  let best: KnownService | null = null;
  let bestLength = 0;
  for (const entry of KNOWN) {
    const match = cleaned.match(entry.re);
    if (!match || match.index === undefined) continue;
    const size = match[0].length;
    if (size > bestLength) {
      best = entry;
      bestLength = size;
    }
  }
  if (!best) return null;
  const leftover = cleaned
    .replace(best.re, " ")
    .replace(/\b(a|an|the|service|services|named|called)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
  if (leftover.length > 18) return null;
  return stamp(best.label, { tier: best.tier, shape: best.shape });
}

function scanKnown(text: string): NamedItem[] {
  const found: Array<{ index: number; length: number; item: NamedItem }> = [];
  for (const entry of KNOWN) {
    const flags = entry.re.flags.includes("g") ? entry.re.flags : `${entry.re.flags}g`;
    const re = new RegExp(entry.re.source, flags);
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      found.push({
        index: match.index,
        length: match[0].length,
        item: stamp(entry.label, { tier: entry.tier, shape: entry.shape }),
      });
    }
  }
  found.sort((a, b) => a.index - b.index || b.length - a.length);
  const kept: NamedItem[] = [];
  let cursor = -1;
  for (const hit of found) {
    if (hit.index < cursor) continue;
    kept.push(hit.item);
    cursor = hit.index + hit.length;
  }
  return kept;
}

function mergeItems(items: NamedItem[]): NamedItem[] {
  const seen = new Set<string>();
  const used = new Set<string>();
  const merged: NamedItem[] = [];
  for (const item of items) {
    const key = item.label.toLowerCase();
    if (!item.label || seen.has(key)) continue;
    seen.add(key);
    let id = slug(item.label);
    let n = 2;
    while (used.has(id)) {
      id = `${slug(item.label)}-${n}`;
      n += 1;
    }
    used.add(id);
    merged.push({ ...item, id });
  }
  return merged;
}

function stamp(label: string, role: { tier: Tier; shape: ShapeKind }): NamedItem {
  return { id: slug(label), label, tier: role.tier, shape: role.shape };
}

function classifyFree(label: string): { tier: Tier; shape: ShapeKind } {
  const text = label.toLowerCase();
  if (/\b(browser|client|customer|shopper|user|internet)\b/.test(text)) {
    return { tier: "client", shape: /\buser\b/.test(text) ? "actor" : "rectangle" };
  }
  if (/\b(gateway|balancer|cdn|ingress|proxy|front door)\b/.test(text)) {
    return { tier: "edge", shape: "hexagon" };
  }
  if (/\b(queue|topic|bus|broker|notification)\b/.test(text)) return { tier: "messaging", shape: "queue" };
  if (/\b(cache|memcache)\b/.test(text)) return { tier: "cache", shape: "cylinder" };
  if (/\b(bucket|blob|storage)\b/.test(text)) return { tier: "storage", shape: "cloud" };
  if (/\b(postgres|mysql|sql|database|db|mongo|warehouse)\b/.test(text)) {
    return { tier: "data", shape: "cylinder" };
  }
  if (/\b(build|test|deploy|lint|compile|ship|release|package|stage)\b/.test(text)) {
    return { tier: "stage", shape: "rectangle" };
  }
  if (/\b(function|worker|service|server|api|app|compute)\b/.test(text)) {
    return { tier: "compute", shape: inferShape(label) };
  }
  return { tier: "other", shape: inferShape(label) };
}

function isNoise(label: string): boolean {
  return /^(architecture|diagram|system|platform|stack|setup|aws|azure|gcp|amazon|google cloud|pipeline|workflow|sequence|login|checkout)$/i.test(
    label,
  );
}

function sequenceDiagram(text: string, items: NamedItem[]): NamedComposition {
  let participants = items.filter((item) => item.tier !== "stage");
  if (participants.length < 2) participants = items;
  if (/\b(login|oauth|oidc|auth)\b/i.test(text) && !participants.some((item) => /^user$/i.test(item.label))) {
    participants = [{ id: "user", label: "User", tier: "client", shape: "actor" }, ...participants];
  }
  const messages: SequenceSpec["messages"] = [];
  for (let index = 0; index < participants.length - 1; index += 1) {
    const from = participants[index];
    const to = participants[index + 1];
    if (!from || !to) continue;
    messages.push({ from: from.id, to: to.id, label: forwardLabel(from, to) });
    messages.push({ from: to.id, to: from.id, label: returnLabel(to), dashed: true });
  }
  const names = participants.map((item) => item.label);
  return {
    context: `Sequence participants named in the request: ${names.join(", ")}. Draw those participants. Do not substitute a different cast.`,
    spec: {
      kind: "sequence",
      title: /\boauth|authorization server|resource server\b/i.test(text) ? "OAuth login" : "Sequence",
      reply: `Drew a sequence: ${names.join(" → ")}.`,
      participants: participants.map((item) => ({ id: item.id, label: item.label, shape: item.shape })),
      messages,
    },
  };
}

function forwardLabel(from: NamedItem, to: NamedItem): string {
  if (/resource/i.test(to.label)) return "GET /resource";
  if (/authorization|auth/i.test(to.label)) return "Authorize";
  if (/webhook/i.test(to.label)) return "Webhook";
  if (/database|db|postgres|sql/i.test(to.label)) return "Query";
  if (from.tier === "client") return "Request";
  return "Call";
}

function returnLabel(from: NamedItem): string {
  if (/authorization|auth/i.test(from.label)) return "Access token";
  if (/resource/i.test(from.label)) return "Protected resource";
  if (/webhook/i.test(from.label)) return "200 OK";
  if (/database|db|postgres|sql/i.test(from.label)) return "Rows";
  return "Response";
}

function workflowDiagram(text: string, items: NamedItem[]): NamedComposition {
  const stages = items.filter((item) => item.tier === "stage" || item.tier === "other" || item.tier === "compute");
  const nodes = (stages.length >= 2 ? stages : items).slice(0, 8);
  const spec: WorkflowSpec = {
    kind: "workflow",
    title: /\bci\s*\/\s*cd|pipeline|continuous\b/i.test(text) ? "CI/CD" : "Workflow",
    reply: `Drew a pipeline: ${nodes.map((node) => node.label).join(" → ")}.`,
    nodes: nodes.map((node, index) => ({
      id: node.id,
      label: node.label,
      shape: node.shape === "actor" ? "rectangle" : node.shape,
      column: index,
      row: 0,
    })),
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index]!.id,
      to: node.id,
      label: stageEdgeLabel(node.label),
    })),
  };
  return {
    context: `Stages named in the request, in order: ${nodes.map((node) => node.label).join(" → ")}. Do not drop a named stage.`,
    spec,
  };
}

function stageEdgeLabel(target: string): string {
  if (/^deploy\b/i.test(target)) return "Deploy";
  const first = target.split(/\s+/)[0] ?? "Next";
  if (/^(build|test|lint|compile|ship|release|package|check)$/i.test(first)) {
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return "Next";
}

function pipelineDiagram(text: string, items: NamedItem[]): NamedComposition {
  const steps = items.filter((item) => item.tier !== "client" && item.tier !== "stage");
  const nodes = (steps.length >= 2 ? steps : items).slice(0, 8);
  const groups = nodes.map((item) => [item]);
  const edges: LayerEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1];
    const to = nodes[index];
    if (!from || !to) continue;
    edges.push({ from: from.id, to: to.id, label: to.tier === "data" ? "Load" : to.tier === "compute" ? "Stream" : "Next" });
  }
  const names = nodes.map((node) => node.label);
  return {
    context: `Pipeline stages named in the request: ${names.join(" → ")}. Do not replace them with a web stack.`,
    spec: {
      kind: "layers",
      title: /\bgcp|google\s+cloud\b/i.test(text) ? "GCP data pipeline" : "Data pipeline",
      reply: `Drew a data pipeline: ${names.join(" → ")}.`,
      groups: groups.map((group) => layerGroup(group)),
      edges,
    },
  };
}

function layerDiagram(text: string, items: NamedItem[]): NamedComposition {
  const body = items.filter((item) => item.tier !== "stage");
  const drawn = body.length >= 2 ? body : items;
  const withClient = ensureClient(text, drawn);
  const groups = orderedGroups(groupItems(withClient));
  const edges = wireGroups(groups);
  const names = drawn.map((item) => item.label);
  const title = layerTitle(text);
  return {
    context: `Services named in the request: ${names.join(", ")}. Draw those services in topic groups. Do not replace them with a different cloud stack.`,
    spec: {
      kind: "layers",
      title,
      reply: `Drew ${title}: ${names.join(", ")}.`,
      groups: groups.map((group) => layerGroup(group)),
      edges,
    },
  };
}

function ensureClient(text: string, items: NamedItem[]): NamedItem[] {
  if (items.some((item) => item.tier === "client")) return items;
  if (!items.some((item) => item.tier === "edge" || item.tier === "compute" || item.tier === "other")) return items;
  const label = /\b(azure|gcp|google\s+cloud|vpc|\balb\b|internet)\b/i.test(text) ? "Internet" : "Client";
  const id = label === "Internet" ? "internet" : "client";
  return [{ id, label, tier: "client", shape: label === "Internet" ? "cloud" : "rectangle" }, ...items];
}

function orderedGroups(groups: NamedItem[][]): NamedItem[][] {
  const spine = groups.filter((group) => group[0] && !SINK.has(group[0].tier));
  const sinks = groups.filter((group) => group[0] && SINK.has(group[0].tier));
  if (spine.length === 0) return groups;
  const cdn = spine.find((group) => group[0] && isCdn(group[0]));
  const storage = sinks.filter((group) => group[0]?.tier === "storage");
  if (cdn && storage.length > 0) {
    const cdnAt = spine.indexOf(cdn);
    const otherSinks = sinks.filter((group) => group[0]?.tier !== "storage");
    return [...spine.slice(0, cdnAt + 1), ...storage, ...spine.slice(cdnAt + 1), ...otherSinks];
  }
  return [...spine, ...sinks];
}

function isCdn(item: NamedItem): boolean {
  return /\b(cloudfront|cloudflare|cdn)\b/i.test(item.label);
}

function groupItems(items: NamedItem[]): NamedItem[][] {
  const groups: NamedItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last[0]?.tier === item.tier) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

function layerGroup(items: NamedItem[]): LayerGroup {
  const tier = items[0]?.tier ?? "other";
  const nodes: LayerNode[] = items.map((item) => ({ id: item.id, label: item.label, shape: item.shape }));
  return {
    id: `${tier}-${items[0]?.id ?? "group"}`,
    label: CLUSTER[tier],
    nodes,
    flow: "column",
  };
}

function wireGroups(groups: NamedItem[][]): LayerEdge[] {
  const edges: LayerEdge[] = [];
  const spine = groups.filter((group) => group[0] && !SINK.has(group[0].tier));
  const sinks = groups.filter((group) => group[0] && SINK.has(group[0].tier));
  const chain = spine.length > 0 ? spine : groups;
  let previous: NamedItem | null = null;
  for (const group of chain) {
    const head = group[0];
    if (!head) continue;
    if (previous) {
      group.forEach((item, index) => {
        edges.push({
          from: previous!.id,
          to: item.id,
          label: relationLabel(previous!, item),
          side: index > 0,
        });
      });
    }
    previous = head;
  }
  const tail = spine[spine.length - 1]?.[0] ?? null;
  if (!tail || spine.length === 0) return edges;
  const cdn = spine.flat().find((item) => isCdn(item)) ?? null;
  const heads = spine.map((group) => group[0]).filter((node): node is NamedItem => Boolean(node));
  let continued = false;
  for (const group of sinks) {
    group.forEach((item, index) => {
      const source = fanoutSource(heads, item, cdn) ?? tail;
      const straight = source.id === tail.id && !continued && index === 0;
      if (straight) continued = true;
      edges.push({
        from: source.id,
        to: item.id,
        label: source.id === cdn?.id && item.tier === "storage" ? "Origin" : relationLabel(source, item),
        side: !straight,
      });
    });
  }
  if (cdn) {
    for (const edge of edges) {
      if (edge.from === cdn.id && edge.label === "Invoke") edge.side = true;
    }
  }
  return edges;
}

/** Data hangs off a private network hop when one exists. Messaging and cache hang off compute. */
function fanoutSource(heads: NamedItem[], item: NamedItem, cdn: NamedItem | null): NamedItem | null {
  if (cdn && item.tier === "storage") return cdn;
  if (item.tier === "data") {
    const network = [...heads].reverse().find((node) => node.tier === "network");
    if (network) return network;
  }
  if (item.tier === "messaging" || item.tier === "cache") {
    const compute = [...heads].reverse().find((node) => node.tier === "compute");
    if (compute) return compute;
  }
  return heads[heads.length - 1] ?? null;
}

function relationLabel(from: NamedItem, to: NamedItem): string {
  if (to.tier === "data") {
    if (/\b(postgres|mysql|sql|rds|aurora)\b/i.test(to.label)) return "SQL";
    return "Read / write";
  }
  if (to.tier === "cache") return "Cache";
  if (to.tier === "messaging") {
    if (/\b(sns|notification|topic|pub\/sub|pubsub|kafka|event|bus)\b/i.test(to.label)) return "Publish";
    return "Send";
  }
  if (to.tier === "storage") return "Origin";
  if (to.tier === "network") return "Private";
  if (to.tier === "edge" || from.tier === "client") return "HTTPS";
  if (to.tier === "compute" && /\b(lambda|function)\b/i.test(to.label)) return "Invoke";
  if (from.tier === "edge") return "HTTP";
  return "Call";
}

function layerTitle(text: string): string {
  if (/\bazure\b/i.test(text)) return "Azure";
  if (/\bgcp\b|\bgoogle\s+cloud\b/i.test(text)) return "GCP";
  if (/\baws\b|\bamazon\b/i.test(text)) return "AWS";
  return "Architecture";
}

function slug(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base || "node";
}

function titleLabel(input: string): string {
  const words = input
    .replace(/[?.!,;:]+$/g, "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9+]+$/gi, ""))
    .filter(Boolean);
  if (words.length === 0 || words.length > 6) return "";
  return words
    .map((word, index) => {
      const key = word.toLowerCase();
      if (SPECIAL[key]) return SPECIAL[key];
      if (SMALL.has(key) && index > 0) return key;
      if (word.length > 1 && /[A-Z]/.test(word.slice(1))) return word;
      if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}
