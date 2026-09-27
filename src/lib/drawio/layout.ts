import { parseStyle, stringifyStyle } from "@/lib/drawio/styles";
import {
  firstChildTag,
  geometryOf,
  listEdges,
  listVertices,
  numberAttr,
  openDiagram,
  serializeDiagram,
  type Geometry,
} from "@/lib/drawio/xml";

type XmlElement = import("@xmldom/xmldom").Element;
type XmlDocument = import("@xmldom/xmldom").Document;

/** Minimum clear space between node boxes after a structural edit. */
export const NODE_GAP = 28;

export interface Point {
  x: number;
  y: number;
}

export interface QualityNode {
  id: string;
  label: string;
  role: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  style: string;
}

export interface QualityEdge {
  id: string;
  fromId: string;
  toId: string;
  from: string;
  to: string;
  label: string;
  style: string;
  points: Point[];
}

export interface QualityReport {
  nodes: QualityNode[];
  edges: QualityEdge[];
  /** Pairs of node labels whose boxes violate NODE_GAP. Containers may hold their children. */
  overlaps: Array<{ a: string; b: string }>;
  /** Edges whose route passes through a node that is not an endpoint, lifeline, or cluster frame. */
  crossings: Array<{ edge: string; node: string }>;
}

/**
 * Untagged vertices are the legacy chain (add / layout). Composed diagrams tag
 * every cell with `drawai=` and already have a type-specific layout, so a later
 * restyle must not shove them.
 */
function cellRole(style: string): string | null {
  return style.match(/(?:^|;)drawai=([^;]*)/)?.[1] ?? null;
}

function isLegacy(cell: XmlElement): boolean {
  return cellRole(cell.getAttribute("style") ?? "") === null;
}

function round(value: number): number {
  return Math.round(value);
}

function setGeometry(cell: XmlElement, x: number, y: number) {
  const geometry = firstChildTag(cell, "mxGeometry");
  if (!geometry) return;
  geometry.setAttribute("x", String(round(x)));
  geometry.setAttribute("y", String(round(y)));
}

function inflate(box: Geometry, pad: number): Geometry {
  return {
    x: box.x - pad / 2,
    y: box.y - pad / 2,
    width: box.width + pad,
    height: box.height + pad,
  };
}

function overlapAmounts(a: Geometry, b: Geometry): { x: number; y: number } | null {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (x <= 0 || y <= 0) return null;
  return { x, y };
}

function contains(outer: Geometry, inner: Geometry, slop = 1): boolean {
  return (
    inner.x >= outer.x - slop &&
    inner.y >= outer.y - slop &&
    inner.x + inner.width <= outer.x + outer.width + slop &&
    inner.y + inner.height <= outer.y + outer.height + slop
  );
}

/** Push overlapping legacy nodes apart. Tagged composition cells stay put. */
export function repairCollisions(doc: XmlDocument, pad = NODE_GAP): boolean {
  const vertices = listVertices(doc).filter(isLegacy);
  let moved = false;
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    for (let i = 0; i < vertices.length; i += 1) {
      for (let j = i + 1; j < vertices.length; j += 1) {
        const left = vertices[i];
        const right = vertices[j];
        if (!left || !right) continue;
        const a = geometryOf(left);
        const b = geometryOf(right);
        const hit = overlapAmounts(inflate(a, pad), inflate(b, pad));
        if (!hit) continue;
        const target = a.x + a.width / 2 <= b.x + b.width / 2 ? right : left;
        const other = target === right ? a : b;
        const current = geometryOf(target);
        if (hit.x <= hit.y) {
          const next = current.x <= other.x ? current.x - hit.x - 1 : current.x + hit.x + 1;
          setGeometry(target, next, current.y);
        } else {
          const next = current.y <= other.y ? current.y - hit.y - 1 : current.y + hit.y + 1;
          setGeometry(target, current.x, next);
        }
        changed = true;
        moved = true;
      }
    }
    if (!changed) break;
  }
  return moved;
}

function horizontallyApart(a: Geometry, b: Geometry): boolean {
  return a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5;
}

function sameBand(a: Geometry, b: Geometry): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlap > Math.min(a.height, b.height) * 0.4) return true;
  const gap = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
  return gap >= 0 && gap < 48;
}

/** Give a horizontal chain one shared top edge. Columns (overlapping x) are left alone. */
export function snapRowTops(doc: XmlDocument) {
  const vertices = listVertices(doc).filter(isLegacy);
  const boxes = vertices.map((vertex) => ({ vertex, ...geometryOf(vertex) }));
  const used = new Set<number>();
  for (let i = 0; i < boxes.length; i += 1) {
    if (used.has(i)) continue;
    const row = [i];
    used.add(i);
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < boxes.length; j += 1) {
        if (used.has(j)) continue;
        const candidate = boxes[j];
        if (!candidate) continue;
        const near = row.some((index) => {
          const member = boxes[index];
          return member ? horizontallyApart(member, candidate) && sameBand(member, candidate) : false;
        });
        if (!near) continue;
        row.push(j);
        used.add(j);
        grew = true;
      }
    }
    if (row.length < 2) continue;
    const tops = row.map((index) => boxes[index]?.y ?? 0).sort((a, b) => a - b);
    const top = tops[Math.floor(tops.length / 2)] ?? tops[0] ?? 0;
    for (const index of row) {
      const box = boxes[index];
      if (!box) continue;
      setGeometry(box.vertex, box.x, top);
      box.y = top;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function port(box: Geometry, fx: number, fy: number): Point {
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

function insetBox(box: Geometry, inset: number): Geometry {
  return {
    x: box.x + inset,
    y: box.y + inset,
    width: Math.max(0, box.width - inset * 2),
    height: Math.max(0, box.height - inset * 2),
  };
}

function pointInside(point: Point, box: Geometry): boolean {
  return point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;
}

function orientations(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientations(a, b, c);
  const o2 = orientations(a, b, d);
  const o3 = orientations(c, d, a);
  const o4 = orientations(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function segmentHitsBox(a: Point, b: Point, box: Geometry): boolean {
  const rect = insetBox(box, 5);
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (pointInside(a, rect) || pointInside(b, rect)) return true;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  for (let i = 0; i < corners.length; i += 1) {
    const start = corners[i];
    const end = corners[(i + 1) % corners.length];
    if (start && end && segmentsCross(a, b, start, end)) return true;
  }
  return false;
}

function pathHits(path: Point[], obstacles: Geometry[]): boolean {
  for (let i = 0; i < path.length - 1; i += 1) {
    const start = path[i];
    const end = path[i + 1];
    if (!start || !end) continue;
    for (const box of obstacles) {
      if (segmentHitsBox(start, end, box)) return true;
    }
  }
  return false;
}

interface Route {
  exitX: number;
  exitY: number;
  entryX: number;
  entryY: number;
  points: Point[];
}

function sharedSideY(source: Geometry, target: Geometry): number {
  const candidates = [source.y + source.height / 2, target.y + target.height / 2, source.y + 32, target.y + 32];
  for (const y of candidates) {
    const inSource = y > source.y + 6 && y < source.y + source.height - 6;
    const inTarget = y > target.y + 6 && y < target.y + target.height - 6;
    if (inSource && inTarget) return y;
  }
  return candidates[0] ?? source.y + source.height / 2;
}

function sharedSideX(source: Geometry, target: Geometry): number {
  const candidates = [source.x + source.width / 2, target.x + target.width / 2];
  for (const x of candidates) {
    const inSource = x > source.x + 6 && x < source.x + source.width - 6;
    const inTarget = x > target.x + 6 && x < target.x + target.width - 6;
    if (inSource && inTarget) return x;
  }
  return candidates[0] ?? source.x + source.width / 2;
}

export function routeBetween(source: Geometry, target: Geometry, obstacles: Geometry[]): Route {
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    const goRight = dx >= 0;
    const exitX = goRight ? 1 : 0;
    const entryX = goRight ? 0 : 1;
    const y = sharedSideY(source, target);
    const exitY = clamp((y - source.y) / source.height, 0.15, 0.85);
    const entryY = clamp((y - target.y) / target.height, 0.15, 0.85);
    const start = port(source, exitX, exitY);
    const end = port(target, entryX, entryY);
    if (!pathHits([start, end], obstacles)) return { exitX, exitY, entryX, entryY, points: [] };
    const above = Math.min(source.y, target.y) - 40;
    const below = Math.max(source.y + source.height, target.y + target.height) + 40;
    for (const lane of [above, below]) {
      const points = [
        { x: start.x, y: lane },
        { x: end.x, y: lane },
      ];
      if (!pathHits([start, ...points, end], obstacles)) return { exitX, exitY, entryX, entryY, points };
    }
    return { exitX, exitY, entryX, entryY, points: [] };
  }

  const goDown = dy >= 0;
  const exitY = goDown ? 1 : 0;
  const entryY = goDown ? 0 : 1;
  const x = sharedSideX(source, target);
  const exitX = clamp((x - source.x) / source.width, 0.15, 0.85);
  const entryX = clamp((x - target.x) / target.width, 0.15, 0.85);
  const start = port(source, exitX, exitY);
  const end = port(target, entryX, entryY);
  if (!pathHits([start, end], obstacles)) return { exitX, exitY, entryX, entryY, points: [] };
  const left = Math.min(source.x, target.x) - 40;
  const right = Math.max(source.x + source.width, target.x + target.width) + 40;
  for (const lane of [right, left]) {
    const points = [
      { x: lane, y: start.y },
      { x: lane, y: end.y },
    ];
    if (!pathHits([start, ...points, end], obstacles)) return { exitX, exitY, entryX, entryY, points };
  }
  return { exitX, exitY, entryX, entryY, points: [] };
}

function writeRoute(doc: XmlDocument, edge: XmlElement, route: Route) {
  const style = parseStyle(edge.getAttribute("style") ?? "");
  style.set("exitX", route.exitX.toFixed(3));
  style.set("exitY", route.exitY.toFixed(3));
  style.set("entryX", route.entryX.toFixed(3));
  style.set("entryY", route.entryY.toFixed(3));
  if (!style.has("edgeStyle")) style.set("edgeStyle", "orthogonalEdgeStyle");
  edge.setAttribute("style", stringifyStyle(style));

  let geometry = firstChildTag(edge, "mxGeometry");
  if (!geometry) {
    geometry = doc.createElement("mxGeometry");
    geometry.setAttribute("relative", "1");
    geometry.setAttribute("as", "geometry");
    edge.appendChild(geometry);
  }
  const children = [...Array.from({ length: geometry.childNodes.length }, (_, index) => geometry.childNodes[index])];
  for (const child of children) {
    if (child && (child as XmlElement).tagName === "Array") geometry.removeChild(child);
  }
  if (route.points.length === 0) return;
  const array = doc.createElement("Array");
  array.setAttribute("as", "points");
  for (const point of route.points) {
    const mx = doc.createElement("mxPoint");
    mx.setAttribute("x", String(round(point.x)));
    mx.setAttribute("y", String(round(point.y)));
    array.appendChild(mx);
  }
  geometry.appendChild(array);
}

function isPreRouted(edge: XmlElement): boolean {
  return /(?:^|;)drawai=routed(?:;|$)/.test(edge.getAttribute("style") ?? "");
}

/** Orthogonal ports, with a lane around anything sitting between the endpoints. */
export function routeEdges(doc: XmlDocument) {
  const vertices = listVertices(doc);
  const byId = new Map(vertices.map((vertex) => [vertex.getAttribute("id") ?? "", vertex]));
  for (const edge of listEdges(doc)) {
    if (isPreRouted(edge)) continue;
    const source = byId.get(edge.getAttribute("source") ?? "");
    const target = byId.get(edge.getAttribute("target") ?? "");
    if (!source || !target) continue;
    const sourceId = source.getAttribute("id");
    const targetId = target.getAttribute("id");
    const obstacles = vertices
      .filter((vertex) => {
        const id = vertex.getAttribute("id");
        if (id === sourceId || id === targetId) return false;
        const role = cellRole(vertex.getAttribute("style") ?? "");
        return role !== "cluster" && role !== "lifeline" && role !== "anchor";
      })
      .map((vertex) => geometryOf(vertex));
    writeRoute(doc, edge, routeBetween(geometryOf(source), geometryOf(target), obstacles));
  }
}

export interface PolishOptions {
  repair?: boolean;
  align?: boolean;
  route?: boolean;
}

/** Collision repair, row alignment, and edge routing for legacy (untagged) cells. */
export function polishDiagram(doc: XmlDocument, options: PolishOptions = {}) {
  if (options.repair !== false) repairCollisions(doc);
  if (options.align !== false) snapRowTops(doc);
  if (options.route !== false) routeEdges(doc);
}

export function finalizeDiagram(xml: string): string {
  const doc = openDiagram(xml);
  polishDiagram(doc);
  return serializeDiagram(doc);
}

function readPoints(edge: XmlElement): Point[] {
  const geometry = firstChildTag(edge, "mxGeometry");
  if (!geometry) return [];
  const points: Point[] = [];
  for (let i = 0; i < geometry.childNodes.length; i += 1) {
    const child = geometry.childNodes[i];
    if (!child || (child as XmlElement).tagName !== "Array") continue;
    for (let j = 0; j < child.childNodes.length; j += 1) {
      const point = child.childNodes[j] as XmlElement | undefined;
      if (!point || point.tagName !== "mxPoint") continue;
      points.push({ x: numberAttr(point, "x", 0), y: numberAttr(point, "y", 0) });
    }
  }
  return points;
}

function labelOf(cell: XmlElement): string {
  const raw = cell.getAttribute("value") ?? "";
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function assessDiagram(xml: string, pad = NODE_GAP): QualityReport {
  const doc = openDiagram(xml);
  const nodes: QualityNode[] = listVertices(doc).map((vertex) => {
    const geometry = geometryOf(vertex);
    const style = vertex.getAttribute("style") ?? "";
    return {
      id: vertex.getAttribute("id") ?? "",
      label: labelOf(vertex),
      role: cellRole(style),
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      style,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: QualityEdge[] = listEdges(doc).map((edge) => {
    const fromId = edge.getAttribute("source") ?? "";
    const toId = edge.getAttribute("target") ?? "";
    return {
      id: edge.getAttribute("id") ?? "",
      fromId,
      toId,
      from: byId.get(fromId)?.label ?? "",
      to: byId.get(toId)?.label ?? "",
      label: labelOf(edge),
      style: edge.getAttribute("style") ?? "",
      points: readPoints(edge),
    };
  });

  const overlaps: QualityReport["overlaps"] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      if (contains(a, b) || contains(b, a)) continue;
      if (overlapAmounts(inflate(a, pad), inflate(b, pad))) {
        overlaps.push({ a: a.label || a.id, b: b.label || b.id });
      }
    }
  }

  const crossings: QualityReport["crossings"] = [];
  for (const edge of edges) {
    const source = byId.get(edge.fromId);
    const target = byId.get(edge.toId);
    if (!source || !target) continue;
    const style = parseStyle(edge.style);
    const exitX = Number(style.get("exitX") ?? "0.5");
    const exitY = Number(style.get("exitY") ?? "0.5");
    const entryX = Number(style.get("entryX") ?? "0.5");
    const entryY = Number(style.get("entryY") ?? "0.5");
    const path = [
      port(source, Number.isFinite(exitX) ? exitX : 0.5, Number.isFinite(exitY) ? exitY : 0.5),
      ...edge.points,
      port(target, Number.isFinite(entryX) ? entryX : 0.5, Number.isFinite(entryY) ? entryY : 0.5),
    ];
    for (const node of nodes) {
      if (node.id === edge.fromId || node.id === edge.toId) continue;
      if (node.role === "cluster" || node.role === "lifeline" || node.role === "anchor") continue;
      const blocked = path.some((start, index) => {
        const end = path[index + 1];
        return end ? segmentHitsBox(start, end, node) : false;
      });
      if (blocked) crossings.push({ edge: edge.label || `${edge.from}→${edge.to}`, node: node.label || node.id });
    }
  }

  return { nodes, edges, overlaps, crossings };
}
