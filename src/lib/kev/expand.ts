import type { ShapeKind } from "@/lib/drawio/styles";
import { diagramIsBlank, summarizeDiagram } from "@/lib/drawio/xml";
import {
  attachLabeledEdges,
  composeDetailedFromBrief,
  composeOnCanvas,
  renderComposition,
  sameMxfile,
  type Composition,
  type LayerSpec,
} from "@/lib/kev/compose";
import { rolePaint, type EntityRole } from "@/lib/kev/entities";
import { parseArchitecture } from "@/lib/kev/plan";
import { researchIdea } from "@/lib/kev/research";
import { isExpandFollowUp, pluralRoleOf, type PluralRole } from "@/lib/kev/scale";
import type { KevDecision } from "@/lib/kev/types";

/**
 * Host-proposed nodes for a scale follow-up or a plural role with no proper name.
 * The open canvas is spliced, not replaced. Research runs only when the role
 * and the open diagram do not say what to add.
 */

type Kind = "client" | "edge" | "compute" | "cache" | "database" | "worker" | "queue" | "storage";

interface Addition {
  label: string;
  kind: Kind;
  shape: ShapeKind;
}

export interface Expansion {
  composition: Composition;
  links: Array<{ from: string; to: string; label: string }>;
}

const ROLE_FOR: Record<Kind, EntityRole> = {
  client: "client",
  edge: "edge",
  compute: "compute",
  cache: "data",
  database: "data",
  worker: "compute",
  queue: "bus",
  storage: "storage",
};

const GROUP_FOR: Record<Kind, string> = {
  client: "Clients",
  edge: "Edge",
  compute: "Services",
  cache: "Caches",
  database: "Data stores",
  worker: "Workers",
  queue: "Messaging",
  storage: "Storage",
};

const POOLS: Record<PluralRole, Addition[]> = {
  database: [
    { label: "Replica", kind: "database", shape: "cylinder" },
    { label: "Search", kind: "database", shape: "cylinder" },
    { label: "Archive", kind: "database", shape: "cylinder" },
  ],
  cache: [
    { label: "Cache", kind: "cache", shape: "cylinder" },
    { label: "Session Cache", kind: "cache", shape: "cylinder" },
    { label: "Edge Cache", kind: "cache", shape: "cylinder" },
  ],
  worker: [
    { label: "Worker", kind: "worker", shape: "rectangle" },
    { label: "Job Worker", kind: "worker", shape: "rectangle" },
    { label: "Scheduler", kind: "worker", shape: "rectangle" },
  ],
  service: [
    { label: "Auth", kind: "compute", shape: "rectangle" },
    { label: "Billing", kind: "compute", shape: "rectangle" },
    { label: "Notifications", kind: "compute", shape: "rectangle" },
  ],
  queue: [
    { label: "Queue", kind: "queue", shape: "queue" },
    { label: "Events", kind: "queue", shape: "queue" },
    { label: "Tasks", kind: "queue", shape: "queue" },
  ],
  storage: [
    { label: "Object Store", kind: "storage", shape: "cloud" },
    { label: "Media Store", kind: "storage", shape: "cloud" },
    { label: "Archive Store", kind: "storage", shape: "cloud" },
  ],
};

export function contentLabels(xml: string): string[] {
  try {
    return summarizeDiagram(xml)
      .vertices.filter((vertex) => !/(?:^|;)drawai=(?:cluster|lifeline|anchor)(?:;|$)/.test(vertex.style))
      .map((vertex) => vertex.label.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function kindOf(label: string): Kind | null {
  const text = label.toLowerCase();
  if (/\b(worker|scheduler|consumer|job)\b/.test(text)) return "worker";
  if (/\b(cache|redis|memcached)\b/.test(text)) return "cache";
  if (/\b(postgres|postgresql|mysql|mariadb|mongo|mongodb|database|replica|sqlite|dynamo|archive|search)\b|\bdb\b/.test(text)) {
    return "database";
  }
  if (/\b(cdn|proxy|gateway|balancer|cloudfront|waf)\b/.test(text)) return "edge";
  if (/\b(queue|kafka|sqs|bus)\b/.test(text)) return "queue";
  if (/\b(s3|bucket|blob|storage)\b/.test(text)) return "storage";
  if (/\b(browser|client|frontend|shopper)\b/.test(text)) return "client";
  if (/\b(app|api|service|server|backend|application)\b/.test(text)) return "compute";
  return null;
}

function architectureCanvas(labels: string[]): boolean {
  return labels.some((label) => kindOf(label) !== null);
}

function unseen(planned: Addition[], existing: string[]): Addition[] {
  const have = new Set(existing.map((label) => label.toLowerCase()));
  const kept: Addition[] = [];
  for (const node of planned) {
    const key = node.label.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    kept.push(node);
  }
  return kept;
}

function anchorFor(kind: Kind, existing: string[]): string | null {
  const ranked: Kind[] =
    kind === "edge"
      ? ["client", "compute"]
      : kind === "worker" || kind === "compute"
        ? ["compute", "edge", "client"]
        : kind === "client"
          ? []
          : ["compute", "worker", "edge", "client"];
  for (const want of ranked) {
    const found = existing.find((label) => kindOf(label) === want);
    if (found) return found;
  }
  return null;
}

function linkText(kind: Kind): string {
  if (kind === "database" || kind === "cache") return "Query";
  if (kind === "storage") return "Put / Get";
  if (kind === "queue") return "Publish";
  if (kind === "edge" || kind === "client") return "HTTPS";
  return "Call";
}

function gapPlan(existing: string[]): Addition[] {
  const counts = new Map<Kind, number>();
  for (const label of existing) {
    const kind = kindOf(label);
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const count = (kind: Kind) => counts.get(kind) ?? 0;
  const planned: Addition[] = [];
  if (count("edge") === 0) planned.push({ label: "CDN", kind: "edge", shape: "hexagon" });
  if (count("cache") === 0) planned.push({ label: "Cache", kind: "cache", shape: "cylinder" });
  if (count("worker") === 0) planned.push({ label: "Worker", kind: "worker", shape: "rectangle" });
  if (count("database") === 0) planned.push({ label: "Postgres", kind: "database", shape: "cylinder" });
  if (count("database") < 2) planned.push({ label: "Replica", kind: "database", shape: "cylinder" });
  if (count("compute") === 0) planned.push({ label: "App", kind: "compute", shape: "rectangle" });
  if (planned.length < 3) planned.push({ label: "Archive", kind: "database", shape: "cylinder" });
  if (planned.length < 3) planned.push({ label: "Scheduler", kind: "worker", shape: "rectangle" });
  return unseen(planned, existing);
}

function rolePlan(role: PluralRole, existing: string[]): Addition[] {
  const pool = POOLS[role];
  const fresh = unseen(pool, existing);
  if (fresh.length >= 2) return fresh;
  const extra: Addition[] = [];
  let index = 2;
  while (fresh.length + extra.length < 3 && index < 8) {
    const seed = pool[0] ?? { label: "Node", kind: "compute" as const, shape: "rectangle" as const };
    extra.push({ ...seed, label: `${seed.label} ${index}` });
    index += 1;
  }
  return unseen([...fresh, ...extra], existing);
}

function composeGrouped(additions: Addition[], existing: string[], title: string): Expansion | null {
  if (additions.length < 2) return null;
  const perRole = new Map<EntityRole, number>();
  const groups: LayerSpec["groups"] = [];
  const links: Expansion["links"] = [];
  const edges: LayerSpec["edges"] = [];
  const ids: string[] = [];
  for (const node of additions) {
    const role = ROLE_FOR[node.kind];
    const nth = perRole.get(role) ?? 0;
    perRole.set(role, nth + 1);
    const paint = rolePaint(role, nth);
    const id = `expand-${ids.length + 1}`;
    ids.push(id);
    let group = groups.find((item) => item.label === GROUP_FOR[node.kind]);
    if (!group) {
      group = { id: `expand-group-${groups.length + 1}`, label: GROUP_FOR[node.kind], flow: "column", nodes: [] };
      groups.push(group);
    }
    group.nodes.push({
      id,
      label: node.label,
      shape: node.shape,
      fill: paint.fill,
      stroke: paint.stroke,
    });
    const anchor = anchorFor(node.kind, existing);
    if (anchor) links.push({ from: anchor, to: node.label, label: linkText(node.kind) });
  }
  if (links.length === 0 && ids.length >= 2) {
    for (let index = 1; index < ids.length; index += 1) {
      edges.push({
        from: ids[index - 1]!,
        to: ids[index]!,
        label: linkText(additions[index]?.kind ?? "compute"),
      });
    }
  }
  const multi = groups.some((group) => group.nodes.length > 1);
  for (const group of groups) {
    if (group.nodes.length > 1) group.flow = "row";
  }
  const spec: LayerSpec = {
    kind: "layers",
    title,
    reply: additions.map((node) => node.label).join(", "),
    // A shared row keeps the gap the quality check expects. One node per group stays a tier row.
    axis: multi ? undefined : "horizontal",
    groups,
    edges,
  };
  return {
    composition: {
      spec,
      colorName: null,
      context: null,
      researchQuery: null,
      layout: "horizontal",
      grounded: true,
    },
    links,
  };
}

/** New nodes for this message, or null when the host should not invent them. */
export function expandComposition(message: string, xml: string): Expansion | null {
  // An N-tier picture on a blank page is the architecture planner's drawing.
  if (diagramIsBlank(xml) && parseArchitecture(message)) return null;
  const role = pluralRoleOf(message);
  const follow = isExpandFollowUp(message);
  if (!role && !follow) return null;
  const existing = contentLabels(xml);
  if (role) return composeGrouped(rolePlan(role, existing), existing, "Added");
  if (!architectureCanvas(existing)) return null;
  return composeGrouped(gapPlan(existing), existing, "Expanded");
}

export function placeExpansion(
  message: string,
  xml: string,
): { xml: string; decision: KevDecision } | null {
  const expansion = expandComposition(message, xml);
  if (!expansion) return null;
  const rendered = renderComposition(expansion.composition);
  const placed = composeOnCanvas(message, xml, expansion.composition, rendered);
  if (placed === "keep" || placed === "unchanged") return null;
  const linked = attachLabeledEdges(placed.xml, expansion.links);
  if (sameMxfile(linked, xml)) return null;
  return { xml: linked, decision: placed.decision };
}

/**
 * When the follow-up names no role and the open diagram is not an architecture,
 * topic notes supply the extra parts. Offline, this stays null.
 */
export async function placeResearchedExpansion(
  message: string,
  xml: string,
  network: boolean,
): Promise<{ xml: string; decision: KevDecision } | null> {
  const placed = placeExpansion(message, xml);
  if (placed) return placed;
  if (!network || diagramIsBlank(xml) || !isExpandFollowUp(message) || pluralRoleOf(message)) return null;
  const existing = contentLabels(xml);
  if (existing.length === 0 || architectureCanvas(existing)) return null;
  const brief = await researchIdea(`Draw ${existing.slice(0, 5).join(" ")} and its interactions`, { network: true });
  if (!brief?.summary) return null;
  const composition = composeDetailedFromBrief(message, brief.summary);
  if (!composition) return null;
  const rendered = renderComposition(composition);
  const spliced = composeOnCanvas(message, xml, composition, rendered);
  if (spliced === "keep" || spliced === "unchanged") return null;
  if (sameMxfile(spliced.xml, xml)) return null;
  return spliced;
}
