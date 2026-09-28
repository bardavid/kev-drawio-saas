import {
  EDGE_STYLE,
  PALETTE,
  SHAPE_SIZE,
  SHAPE_STYLE,
  applyColors,
  inferColorName,
  inferShape,
  parseStyle,
  type ShapeKind,
} from "@/lib/drawio/styles";
import {
  DiagramXmlError,
  absoluteGeometry,
  cellLabel,
  findCellById,
  firstChildTag,
  getRoot,
  listEdges,
  listVertices,
  nextCellId,
  numberAttr,
  openDiagram,
  serializeDiagram,
} from "@/lib/drawio/xml";
import { polishDiagram } from "@/lib/drawio/layout";
import type { DiagramOperation, DiagramSlots, KevDecision } from "@/lib/kev/types";

export { DiagramXmlError };

type XmlElement = import("@xmldom/xmldom").Element;
type XmlDocument = import("@xmldom/xmldom").Document;

const FILLER = new Set(["box", "shape", "node", "component", "service", "the", "a", "an"]);

const QUERY_ALIASES: Array<{ query: RegExp; label: RegExp }> = [
  {
    query: /^(database|db|data store|datastore)$/,
    label: /\b(postgres|postgresql|mysql|mariadb|mongo|mongodb|sqlite|dynamo|database|db)\b/,
  },
  { query: /^(cache|caching)$/, label: /\b(redis|memcache|memcached|cache)\b/ },
  { query: /^(api|backend|server)$/, label: /\b(api|backend)\b/ },
  { query: /^(client|frontend|browser|web app|web|user)$/, label: /\b(client|browser|frontend|web)\b/ },
  {
    query: /^(app servers?|application servers?|web servers?|servers?)$/,
    label: /\b(app|application|server)s?\b/,
  },
];

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an)\s+/, "");
}

function significantTokens(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((token) => token && !FILLER.has(token));
}

const COLOR_WORDS = new Set(Object.keys(PALETTE));

function scoreVertex(label: string, query: string): number {
  const rawQuery = normalizeName(query);
  const rawLabel = normalizeName(label);
  if (!rawQuery || !rawLabel) return 0;
  const queryTokens = significantTokens(query);
  const labelTokens = significantTokens(label);
  const q = queryTokens.join(" ") || rawQuery;
  const l = labelTokens.join(" ") || rawLabel;
  if (l === q) return 100;
  if (queryTokens.length > 0 && queryTokens.every((token) => labelTokens.includes(token))) return 90;
  if (labelTokens.length > 0 && labelTokens.every((token) => queryTokens.includes(token))) return 82;
  for (const alias of QUERY_ALIASES) {
    if (alias.query.test(q) && alias.label.test(rawLabel)) return 92;
  }
  return 0;
}

/** Color words are style, not part of a shape name. */
function mentionTokens(value: string): string[] {
  return significantTokens(value).filter((token) => !COLOR_WORDS.has(token));
}

/** Query tokens are a leading prefix of the canvas label. */
function leadingScore(label: string, query: string): number {
  const q = mentionTokens(query);
  const l = significantTokens(label);
  if (q.length === 0 || l.length === 0 || q.length > l.length) return 0;
  if (!q.every((token, index) => l[index] === token)) return 0;
  return 70 + Math.min(q.length, 9);
}

function isContentVertex(vertex: XmlElement): boolean {
  if (vertex.getAttribute("vertex") !== "1") return false;
  if ((vertex.getAttribute("style") ?? "").includes("drawai=cluster")) return false;
  return cellLabel(vertex).trim().length > 0;
}

function bestVertex(
  doc: XmlDocument,
  query: string,
  score: (label: string, query: string) => number,
  include: (vertex: XmlElement) => boolean = () => true,
): XmlElement | null {
  let best: XmlElement | null = null;
  let bestScore = 0;
  for (const vertex of listVertices(doc)) {
    if (!include(vertex)) continue;
    const value = score(cellLabel(vertex), query);
    if (value > bestScore) {
      best = vertex;
      bestScore = value;
    }
  }
  return bestScore >= 50 ? best : null;
}

/**
 * Resolve a mention to a shape already on the canvas.
 * Trailing words that are not part of any label ("stages", "of this pipeline")
 * are dropped until a leading prefix hits one label. They do not become a new name.
 */
export function findVertex(doc: XmlDocument, query: string): XmlElement | null {
  const direct = bestVertex(doc, query, scoreVertex);
  if (direct) return direct;
  const tokens = mentionTokens(query);
  const stripped = tokens.join(" ");
  if (stripped && stripped !== normalizeName(query)) {
    const colored = bestVertex(doc, stripped, scoreVertex);
    if (colored) return colored;
  }
  for (let count = tokens.length - 1; count >= 1; count -= 1) {
    const prefix = tokens.slice(0, count).join(" ");
    const hit = bestVertex(doc, prefix, leadingScore);
    if (hit) return hit;
  }
  return null;
}

function hasLeftover(query: string, label: string): boolean {
  const labelTokens = significantTokens(label);
  return mentionTokens(query).some((token) => !labelTokens.includes(token));
}

function alignMention(
  doc: XmlDocument,
  value: string | null | undefined,
  rewritten: Map<string, string>,
): string | null {
  if (!value) return null;
  if (edgeQuery(value)) return value;
  const found = findVertex(doc, value);
  if (!found) return value;
  const label = cellLabel(found);
  if (!label) return value;
  if (hasLeftover(value, label)) rewritten.set(value, label);
  return hasLeftover(value, label) ? label : value;
}

function alignSlots(doc: XmlDocument, slots: DiagramSlots, rewritten: Map<string, string>): DiagramSlots {
  return {
    ...slots,
    from: alignMention(doc, slots.from, rewritten),
    to: alignMention(doc, slots.to, rewritten),
    target: alignMention(doc, slots.target, rewritten),
  };
}

/** Point from/to/target at canvas labels when the phrase has leftover tokens. */
export function groundDecision(xml: string, decision: KevDecision): KevDecision {
  let doc: XmlDocument;
  try {
    doc = openDiagram(xml);
  } catch {
    return decision;
  }
  const rewritten = new Map<string, string>();
  const slots = alignSlots(doc, decision.slots, rewritten);
  const operations = decision.operations.map((operation) => ({
    ...operation,
    slots: alignSlots(doc, operation.slots, rewritten),
  }));
  let reply = decision.reply;
  const keys = [...rewritten.keys()].sort((left, right) => right.length - left.length);
  for (const key of keys) {
    const value = rewritten.get(key);
    if (value) reply = reply.split(key).join(value);
  }
  return { ...decision, slots, operations, reply };
}

function requireVertex(doc: XmlDocument, query: string): XmlElement {
  const found = findVertex(doc, query);
  if (!found) {
    throw new DiagramXmlError(`I couldn't find a shape named “${query}”.`);
  }
  return found;
}

const EDGE_QUERY =
  /^(?:(?:all|every|the|of|a|an|these|those|my|their|its)\s+)*(arrows?|edges?|connectors?|lines?)(?:\s+(?:color|colour))?$/;

/** arrows / edges / connectors / lines name the diagram edges, not a vertex. */
export function edgeQuery(value: string): string | null {
  const text = value
    .trim()
    .toLowerCase()
    .replace(/[?.!,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.match(EDGE_QUERY)?.[1] ?? null;
}

function edgeColor(slots: DiagramSlots): string | null {
  const named = slots.colorName ? PALETTE[slots.colorName] : undefined;
  if (named) return slots.strokeColor || named.stroke;
  if (slots.strokeColor) return slots.strokeColor;
  if (slots.fillColor) return slots.fillColor;
  return null;
}

function setStyleProp(style: string, key: string, value: string): string {
  const pattern = new RegExp(`(^|;)${key}=[^;]*`);
  if (pattern.test(style)) return style.replace(pattern, `$1${key}=${value}`);
  const body = style.trim();
  if (!body) return `${key}=${value};`;
  return `${body.endsWith(";") ? body : `${body};`}${key}=${value};`;
}

function resolvePalette(slots: DiagramSlots): { fill: string | null; stroke: string | null; font: string | null } {
  const named = slots.colorName ? PALETTE[slots.colorName] : undefined;
  if (named) {
    return {
      fill: slots.fillColor || named.fill,
      stroke: slots.strokeColor || named.stroke,
      font: named.font ?? null,
    };
  }
  if (slots.fillColor) {
    return { fill: slots.fillColor, stroke: slots.strokeColor || "#334155", font: null };
  }
  return { fill: slots.strokeColor ? null : null, stroke: slots.strokeColor ?? null, font: null };
}

function clearEdgeWaypoints(doc: XmlDocument) {
  for (const edge of listEdges(doc)) {
    const geometry = firstChildTag(edge, "mxGeometry");
    if (!geometry) continue;
    while (geometry.firstChild) geometry.removeChild(geometry.firstChild);
    geometry.setAttribute("relative", "1");
    geometry.setAttribute("as", "geometry");
    geometry.removeAttribute("x");
    geometry.removeAttribute("y");
    geometry.removeAttribute("width");
    geometry.removeAttribute("height");
  }
}

function shiftRightOf(doc: XmlDocument, minX: number, dx: number) {
  if (dx <= 0) return;
  const vertices = listVertices(doc);
  const abs = new Map(vertices.map((vertex) => [vertex, absoluteGeometry(vertex)]));
  const moving = new Set<XmlElement>();
  const growing = new Set<XmlElement>();
  for (const vertex of vertices) {
    const box = abs.get(vertex);
    if (!box) continue;
    const style = vertex.getAttribute("style") ?? "";
    // A topic container that starts left of the insert has to grow, or the shifted shape leaves it.
    if (style.includes("drawai=cluster") && box.x < minX - 0.5 && box.x + box.width >= minX - 0.5) {
      growing.add(vertex);
      continue;
    }
    if (box.x >= minX - 0.5) moving.add(vertex);
  }
  if (moving.size === 0 && growing.size === 0) return;
  for (const vertex of growing) {
    const geometry = firstChildTag(vertex, "mxGeometry");
    if (!geometry) continue;
    const width = numberAttr(geometry, "width", 0);
    geometry.setAttribute("width", String(Math.round(width + dx)));
  }
  for (const vertex of moving) {
    const parentId = vertex.getAttribute("parent");
    const parent = parentId ? findCellById(doc, parentId) : null;
    if (parent && moving.has(parent)) continue;
    const geometry = firstChildTag(vertex, "mxGeometry");
    if (!geometry) continue;
    const x = numberAttr(geometry, "x", 0);
    geometry.setAttribute("x", String(Math.round(x + dx)));
  }
  clearEdgeWaypoints(doc);
}

function connectCells(doc: XmlDocument, source: XmlElement, target: XmlElement, label: string, style = EDGE_STYLE) {
  const sourceId = source.getAttribute("id");
  const targetId = target.getAttribute("id");
  if (!sourceId || !targetId) throw new DiagramXmlError("A shape is missing an id.");
  if (sourceId === targetId) throw new DiagramXmlError("A shape can't connect to itself.");
  for (const edge of listEdges(doc)) {
    if (edge.getAttribute("source") === sourceId && edge.getAttribute("target") === targetId) {
      if (label) edge.setAttribute("value", label);
      return;
    }
  }
  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", nextCellId(doc));
  cell.setAttribute("value", label);
  cell.setAttribute("style", style);
  cell.setAttribute("edge", "1");
  cell.setAttribute("parent", "1");
  cell.setAttribute("source", sourceId);
  cell.setAttribute("target", targetId);
  const geometry = doc.createElement("mxGeometry");
  geometry.setAttribute("relative", "1");
  geometry.setAttribute("as", "geometry");
  cell.appendChild(geometry);
  getRoot(doc).appendChild(cell);
}

function shiftDownOf(doc: XmlDocument, minY: number, dy: number) {
  if (dy <= 0) return;
  const vertices = listVertices(doc);
  const moving = new Set<XmlElement>();
  for (const vertex of vertices) {
    if (absoluteGeometry(vertex).y >= minY - 0.5) moving.add(vertex);
  }
  if (moving.size === 0) return;
  for (const vertex of moving) {
    const parentId = vertex.getAttribute("parent");
    const parent = parentId ? findCellById(doc, parentId) : null;
    if (parent && moving.has(parent)) continue;
    const geometry = firstChildTag(vertex, "mxGeometry");
    if (!geometry) continue;
    const y = numberAttr(geometry, "y", 0);
    geometry.setAttribute("y", String(Math.round(y + dy)));
  }
  clearEdgeWaypoints(doc);
}

/** Keep a restyle (blue arrows) when the edge between two stages is replaced. */
function carriedEdgeStyle(edge: XmlElement | null): string {
  if (!edge) return EDGE_STYLE;
  const parsed = parseStyle(edge.getAttribute("style") ?? "");
  let style = EDGE_STYLE;
  const stroke = parsed.get("strokeColor");
  const fill = parsed.get("fillColor");
  if (stroke) style = setStyleProp(style, "strokeColor", stroke);
  if (fill) style = setStyleProp(style, "fillColor", fill);
  return style;
}

function findEdgeBetween(doc: XmlDocument, source: XmlElement, target: XmlElement): XmlElement | null {
  const sourceId = source.getAttribute("id");
  const targetId = target.getAttribute("id");
  let reverse: XmlElement | null = null;
  for (const edge of listEdges(doc)) {
    const from = edge.getAttribute("source");
    const to = edge.getAttribute("target");
    if (from === sourceId && to === targetId) return edge;
    if (from === targetId && to === sourceId) reverse = edge;
  }
  return reverse;
}

/** Splice one new vertex onto the edge between two shapes. Neighbors keep their place. */
function insertBetween(
  doc: XmlDocument,
  slots: DiagramSlots,
  label: string,
  size: { width: number; height: number },
  style: string,
) {
  const fromQuery = slots.from ?? "";
  const toQuery = slots.to ?? "";
  const fromNode = requireVertex(doc, fromQuery);
  const toNode = requireVertex(doc, toQuery);
  if (fromNode === toNode) {
    throw new DiagramXmlError(`“${fromQuery}” and “${toQuery}” name the same shape.`);
  }
  const fromBox = absoluteGeometry(fromNode);
  const toBox = absoluteGeometry(toNode);
  const gap = 80;
  let x = fromBox.x;
  let y = fromBox.y;
  if (toBox.x >= fromBox.x) {
    x = fromBox.x + fromBox.width + gap;
    y = fromBox.y;
    const need = x + size.width + gap;
    if (toBox.x < need) shiftRightOf(doc, toBox.x, need - toBox.x);
  } else {
    y = fromBox.y + fromBox.height + gap;
    const need = y + size.height + gap;
    if (toBox.y < need) shiftDownOf(doc, toBox.y, need - toBox.y);
  }
  const carried = carriedEdgeStyle(findEdgeBetween(doc, fromNode, toNode));
  const fromParent = fromNode.getAttribute("parent");
  const sharedParent =
    fromParent && fromParent === toNode.getAttribute("parent") ? findCellById(doc, fromParent) : null;
  const cell = createVertex(doc, label, style, x, y, size.width, size.height, sharedParent);
  removeEdgesBetween(doc, fromNode, toNode);
  connectCells(doc, fromNode, cell, slots.edgeLabel ?? "", carried);
  connectCells(doc, cell, toNode, "", carried);
}

function removeEdgesBetween(doc: XmlDocument, source: XmlElement, target: XmlElement) {
  const sourceId = source.getAttribute("id");
  const targetId = target.getAttribute("id");
  const root = getRoot(doc);
  for (const edge of [...listEdges(doc)]) {
    const from = edge.getAttribute("source");
    const to = edge.getAttribute("target");
    if ((from === sourceId && to === targetId) || (from === targetId && to === sourceId)) {
      root.removeChild(edge);
    }
  }
}

function incomingSources(doc: XmlDocument, target: XmlElement): XmlElement[] {
  const targetId = target.getAttribute("id");
  const sources: XmlElement[] = [];
  for (const edge of listEdges(doc)) {
    if (edge.getAttribute("target") !== targetId) continue;
    const sourceId = edge.getAttribute("source");
    if (!sourceId) continue;
    const source = findCellById(doc, sourceId);
    if (source?.getAttribute("vertex") === "1") sources.push(source);
  }
  return sources;
}

function createVertex(
  doc: XmlDocument,
  label: string,
  style: string,
  x: number,
  y: number,
  width: number,
  height: number,
  parent: XmlElement | null = null,
): XmlElement {
  const parentId = parent?.getAttribute("id");
  const nested = Boolean(parentId && parentId !== "1" && parentId !== "0");
  let left = x;
  let top = y;
  if (nested && parent) {
    const origin = absoluteGeometry(parent);
    left = x - origin.x;
    top = y - origin.y;
  }
  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", nextCellId(doc));
  cell.setAttribute("value", label);
  cell.setAttribute("style", style);
  cell.setAttribute("vertex", "1");
  cell.setAttribute("parent", nested && parentId ? parentId : "1");
  const geometry = doc.createElement("mxGeometry");
  geometry.setAttribute("x", String(Math.round(left)));
  geometry.setAttribute("y", String(Math.round(nested ? top : Math.max(40, top))));
  geometry.setAttribute("width", String(width));
  geometry.setAttribute("height", String(height));
  geometry.setAttribute("as", "geometry");
  cell.appendChild(geometry);
  getRoot(doc).appendChild(cell);
  return cell;
}

function addShape(doc: XmlDocument, slots: DiagramSlots) {
  const label = slots.label?.trim() ?? "";
  if (!label) throw new DiagramXmlError("What should the new shape be called?");
  const kind: ShapeKind = slots.shape ?? inferShape(label);
  const palette = resolvePalette({
    ...slots,
    colorName: slots.colorName ?? (slots.fillColor ? null : inferColorName(label, kind)),
  });
  const size = SHAPE_SIZE[kind];
  const style = applyColors(SHAPE_STYLE[kind], palette.fill, palette.stroke, palette.font);

  let x = 80;
  let y = 180;
  let beforeAnchor: XmlElement | null = null;
  let fromAnchor: XmlElement | null = null;
  let toAnchor: XmlElement | null = null;

  if (slots.from && slots.to && slots.place !== "before" && slots.place !== "after") {
    insertBetween(doc, slots, label, size, style);
    return;
  }

  if (slots.place === "before") {
    const query = slots.target || slots.to;
    if (!query) throw new DiagramXmlError("Say which shape to insert in front of.");
    beforeAnchor = requireVertex(doc, query);
    const anchor = absoluteGeometry(beforeAnchor);
    x = anchor.x;
    y = anchor.y + Math.round((anchor.height - size.height) / 2);
    shiftRightOf(doc, anchor.x, size.width + 80);
  } else if (slots.from || slots.place === "after") {
    const query = slots.from || slots.target;
    if (!query) throw new DiagramXmlError("Say which shape to connect from.");
    fromAnchor = requireVertex(doc, query);
    const anchor = absoluteGeometry(fromAnchor);
    x = anchor.x + anchor.width + 80;
    y = anchor.y + Math.round((anchor.height - size.height) / 2);
    shiftRightOf(doc, x, size.width + 40);
  } else if (slots.to) {
    toAnchor = requireVertex(doc, slots.to);
    const anchor = absoluteGeometry(toAnchor);
    x = Math.max(80, anchor.x - size.width - 80);
    y = anchor.y + Math.round((anchor.height - size.height) / 2);
  } else {
    let maxRight = 80;
    for (const vertex of listVertices(doc)) {
      const anchor = absoluteGeometry(vertex);
      maxRight = Math.max(maxRight, anchor.x + anchor.width + 80);
    }
    x = maxRight;
  }

  const nestedUnder = beforeAnchor ?? fromAnchor ?? toAnchor;
  const parent =
    nestedUnder && nestedUnder.getAttribute("parent")
      ? findCellById(doc, nestedUnder.getAttribute("parent") ?? "")
      : null;
  const cell = createVertex(doc, label, style, x, y, size.width, size.height, parent);

  if (beforeAnchor) {
    for (const source of incomingSources(doc, beforeAnchor)) {
      removeEdgesBetween(doc, source, beforeAnchor);
      connectCells(doc, source, cell, "");
    }
    connectCells(doc, cell, beforeAnchor, slots.edgeLabel ?? "");
  } else if (fromAnchor) {
    connectCells(doc, fromAnchor, cell, slots.edgeLabel ?? "");
  } else if (toAnchor) {
    connectCells(doc, cell, toAnchor, slots.edgeLabel ?? "");
  }
}

function editShape(doc: XmlDocument, slots: DiagramSlots) {
  const query = slots.target || slots.label;
  if (!query) throw new DiagramXmlError("Name the shape to edit.");
  if (edgeQuery(query)) {
    styleEdges(doc, slots);
    return;
  }
  const hasChange = Boolean(slots.newLabel || slots.shape || slots.colorName || slots.fillColor || slots.strokeColor);
  if (!hasChange) throw new DiagramXmlError("Say what should change on that shape.");
  const target = requireVertex(doc, query);
  if (slots.newLabel) target.setAttribute("value", slots.newLabel);
  if (slots.shape) {
    const previous = parseStyle(target.getAttribute("style") ?? "");
    const palette = resolvePalette(slots);
    target.setAttribute(
      "style",
      applyColors(
        SHAPE_STYLE[slots.shape],
        palette.fill || previous.get("fillColor") || null,
        palette.stroke || previous.get("strokeColor") || null,
        palette.font || previous.get("fontColor") || null,
      ),
    );
    const geometry = firstChildTag(target, "mxGeometry");
    const size = SHAPE_SIZE[slots.shape];
    geometry?.setAttribute("width", String(size.width));
    geometry?.setAttribute("height", String(size.height));
    return;
  }
  if (slots.colorName || slots.fillColor || slots.strokeColor) {
    const palette = resolvePalette(slots);
    target.setAttribute(
      "style",
      applyColors(target.getAttribute("style") || SHAPE_STYLE.rectangle, palette.fill, palette.stroke, palette.font),
    );
  }
}

function deleteShape(doc: XmlDocument, slots: DiagramSlots) {
  const query = slots.target || slots.label;
  if (!query) throw new DiagramXmlError("Name the shape to delete.");
  const target = requireVertex(doc, query);
  const id = target.getAttribute("id");
  const cells = doc.getElementsByTagName("mxCell");
  const attached: XmlElement[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (!cell || cell === target) continue;
    if (
      cell.getAttribute("parent") === id ||
      cell.getAttribute("source") === id ||
      cell.getAttribute("target") === id
    ) {
      attached.push(cell);
    }
  }
  for (const cell of attached) cell.parentNode?.removeChild(cell);
  target.parentNode?.removeChild(target);
}

function connect(doc: XmlDocument, slots: DiagramSlots) {
  if (!slots.from || !slots.to) {
    throw new DiagramXmlError("Connect needs both a source and a target.");
  }
  connectCells(doc, requireVertex(doc, slots.from), requireVertex(doc, slots.to), slots.edgeLabel ?? "");
}

function styleEdges(doc: XmlDocument, slots: DiagramSlots) {
  const color = edgeColor(slots);
  if (!color) {
    throw new DiagramXmlError("Name a color, for example “Make the arrows blue.”");
  }
  // from / to are set only when the user named an endpoint. Otherwise every edge changes.
  const fromId = slots.from ? requireVertex(doc, slots.from).getAttribute("id") : null;
  const toId = slots.to ? requireVertex(doc, slots.to).getAttribute("id") : null;
  const edges = listEdges(doc).filter((edge) => {
    const source = edge.getAttribute("source");
    const target = edge.getAttribute("target");
    if (fromId && toId) {
      return (source === fromId && target === toId) || (source === toId && target === fromId);
    }
    if (fromId) return source === fromId;
    if (toId) return target === toId;
    return true;
  });
  if (edges.length === 0) throw new DiagramXmlError("There are no arrows to restyle.");
  for (const edge of edges) {
    const current = edge.getAttribute("style") || EDGE_STYLE;
    const next = setStyleProp(setStyleProp(current, "strokeColor", color), "fillColor", color);
    edge.setAttribute("style", next);
  }
}

function styleShapes(doc: XmlDocument, slots: DiagramSlots) {
  const query = slots.target || slots.label;
  if (query && edgeQuery(query)) {
    styleEdges(doc, slots);
    return;
  }
  const palette = resolvePalette(slots);
  if (!palette.fill && !palette.stroke) {
    throw new DiagramXmlError("Name a color, for example “Make the API red.”");
  }
  const vertices = query ? [requireVertex(doc, query)] : listVertices(doc).filter((vertex) => !isChrome(vertex));
  if (vertices.length === 0) throw new DiagramXmlError("There are no shapes to restyle.");
  for (const vertex of vertices) {
    vertex.setAttribute(
      "style",
      applyColors(vertex.getAttribute("style") || SHAPE_STYLE.rectangle, palette.fill, palette.stroke, palette.font),
    );
  }
}

function isChrome(vertex: XmlElement): boolean {
  return /(?:^|;)drawai=(?:lifeline|cluster|anchor)(?:;|$)/.test(vertex.getAttribute("style") ?? "");
}

function layoutDiagram(doc: XmlDocument, slots: DiagramSlots) {
  const vertical = slots.layout === "vertical";
  const order = new Map<string, number>();
  for (const [index, label] of (slots.sequence ?? []).entries()) {
    const key = normalizeName(label);
    if (key && !order.has(key)) order.set(key, index);
  }
  const vertices = [...listVertices(doc)].sort((a, b) => {
    const leftRank = order.get(normalizeName(cellLabel(a)));
    const rightRank = order.get(normalizeName(cellLabel(b)));
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    const left = absoluteGeometry(a);
    const right = absoluteGeometry(b);
    if (vertical) return left.y - right.y || left.x - right.x;
    return left.x - right.x || left.y - right.y;
  });
  let cursor = 80;
  for (const vertex of vertices) {
    const geometry = firstChildTag(vertex, "mxGeometry");
    if (!geometry) continue;
    const width = numberAttr(geometry, "width", 140);
    const height = numberAttr(geometry, "height", 64);
    vertex.setAttribute("parent", "1");
    if (vertical) {
      geometry.setAttribute("x", "200");
      geometry.setAttribute("y", String(cursor));
      cursor += height + 72;
    } else {
      geometry.setAttribute("x", String(cursor));
      geometry.setAttribute("y", "180");
      cursor += width + 80;
    }
  }
  clearEdgeWaypoints(doc);
}

function applyOperation(doc: XmlDocument, operation: DiagramOperation) {
  switch (operation.intent) {
    case "add_shape":
      addShape(doc, operation.slots);
      return;
    case "edit_shape":
      editShape(doc, operation.slots);
      return;
    case "delete_shape":
      deleteShape(doc, operation.slots);
      return;
    case "connect":
      connect(doc, operation.slots);
      return;
    case "style":
      styleShapes(doc, operation.slots);
      return;
    case "layout":
      layoutDiagram(doc, operation.slots);
      return;
    default: {
      const exhaustive: never = operation.intent;
      throw new DiagramXmlError(`Unsupported diagram operation: ${exhaustive}`);
    }
  }
}

export function applyOperations(xml: string, operations: DiagramOperation[]): string {
  const doc = openDiagram(xml);
  for (const operation of operations) applyOperation(doc, operation);
  const structural = operations.some((operation) => operation.intent !== "style");
  if (structural) polishDiagram(doc);
  return serializeDiagram(doc);
}

const PRONOUN_NODE = /^(?:it|this|that|this node|that node|this shape|that shape|this box|that box|the node|the shape|the box)$/i;
const EDGE_ONLY = /^(?:edges?|arrows?|connectors?|lines?)$/i;

function cleanNodeQuery(raw: string): string {
  return raw
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:a|an|the)$/i, "")
    .replace(/\s+(?:node|shape|box|vertex)$/i, "")
    .replace(/[?.!]+$/g, "")
    .trim();
}

function splitNodeNames(raw: string): string[] {
  const parts = raw
    .split(/\s*,\s*|\s+\band\s+/i)
    .map((part) => cleanNodeQuery(part))
    .filter((part) => part && !EDGE_ONLY.test(part));
  const named = parts.filter((part) => !PRONOUN_NODE.test(part));
  return named;
}

/**
 * “Make X a label”, “X should be labels instead of nodes”, “make it a label instead of a node”.
 * `queries` is empty when the node is a pronoun (“it”, “this node”).
 * Null when the message is not that edit.
 */
export function parseNodeToEdgeLabel(message: string): { queries: string[] } | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text || !/\blabels?\b/i.test(text)) return null;

  const should = text.match(
    /^(?:please\s+)?(.+?)\s+(?:should|must|needs?\s+to)\s+be\s+(?:an?\s+)?(?:edge\s+)?labels?\s+instead\s+of\s+(?:an?\s+)?nodes?\s*$/i,
  );
  if (should?.[1]) {
    const queries = splitNodeNames(should[1]);
    if (queries.length === 0 && !PRONOUN_NODE.test(cleanNodeQuery(should[1]))) return null;
    return { queries };
  }

  const instead = text.match(
    /^(?:please\s+)?(?:(?:make|turn|use)\s+)?(?:(.+?)\s+)?labels?\s+instead\s+of\s+(?:an?\s+)?nodes?(?:\s+(?:for|on)\s+(?:the\s+)?(.+))?\s*$/i,
  );
  if (instead) {
    const queries = splitNodeNames(instead[2] || instead[1] || "");
    return { queries };
  }

  const asLabel = text.match(/\buse\s+(?:the\s+)?(.+?)\s+as\s+(?:an?\s+)?(?:edge\s+)?labels?(?:\s+instead\s+of\s+(?:an?\s+)?nodes?)?\s*$/i);
  if (asLabel?.[1]) {
    const named = cleanNodeQuery(asLabel[1]);
    if (!named || EDGE_ONLY.test(named)) return null;
    return { queries: PRONOUN_NODE.test(named) ? [] : splitNodeNames(named) };
  }

  const into = text.match(
    /\b(?:make|turn|convert|change)\s+(?:the\s+)?(.+?)\s+(?:(?:into|to|as)\s+)?(?:an?\s+)?(?:edge\s+)?labels?(?:\s+instead\s+of\s+(?:an?\s+)?nodes?)?\s*$/i,
  );
  if (!into?.[1]) return null;
  const named = cleanNodeQuery(into[1]);
  if (!named || EDGE_ONLY.test(named)) return null;
  return { queries: PRONOUN_NODE.test(named) ? [] : splitNodeNames(named) };
}

function isBareShapeName(message: string): boolean {
  const text = message.trim().replace(/[?.!]+$/g, "");
  if (!text || text.length > 80) return false;
  if (/\b(?:make|turn|draw|label|instead|should|edit|change|colou?r|figure|invent|detailed|sketch)\b/i.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 6;
}

function contentVertices(doc: XmlDocument): XmlElement[] {
  return listVertices(doc).filter(isContentVertex);
}

function foldToken(token: string): string {
  const word = token.toLowerCase();
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function fuzzyNameScore(label: string, query: string): number {
  const direct = scoreVertex(label, query);
  if (direct >= 50) return direct;
  const queryTokens = significantTokens(query).map(foldToken);
  const labelTokens = significantTokens(label).map(foldToken);
  if (queryTokens.length === 0 || labelTokens.length === 0) return 0;
  if (queryTokens.join(" ") === labelTokens.join(" ")) return 96;
  if (queryTokens.every((token) => labelTokens.includes(token))) return 88;
  return 0;
}

function findContentVertex(doc: XmlDocument, query: string): XmlElement | null {
  const direct = bestVertex(doc, query, fuzzyNameScore, isContentVertex);
  if (direct) return direct;
  const tokens = mentionTokens(query);
  const stripped = tokens.join(" ");
  if (stripped && stripped !== normalizeName(query)) {
    const colored = bestVertex(doc, stripped, fuzzyNameScore, isContentVertex);
    if (colored) return colored;
  }
  for (let count = tokens.length - 1; count >= 1; count -= 1) {
    const prefix = tokens.slice(0, count).join(" ");
    const hit = bestVertex(doc, prefix, leadingScore, isContentVertex);
    if (hit) return hit;
  }
  return null;
}

function recency(cell: XmlElement): number {
  const id = cell.getAttribute("id") ?? "";
  const numeric = Number(id);
  if (Number.isFinite(numeric)) return numeric;
  const digits = id.match(/(\d+)/);
  if (digits?.[1]) return Number(digits[1]);
  return absoluteGeometry(cell).x;
}

function mentioned(label: string, text: string): boolean {
  const needle = normalizeName(label);
  const hay = normalizeName(text);
  if (!needle || !hay) return false;
  return ` ${hay} `.includes(` ${needle} `);
}

function resolveLabelVertex(doc: XmlDocument, query: string | null, earlier: string): XmlElement | null {
  if (query) {
    const found = findContentVertex(doc, query);
    if (found) return found;
  }
  const content = contentVertices(doc);
  const named = earlier.trim() ? content.filter((vertex) => mentioned(cellLabel(vertex), earlier)) : [];
  const pool = named.length > 0 ? named : content;
  if (pool.length === 0) return null;
  return pool.reduce((best, vertex) => (recency(vertex) > recency(best) ? vertex : best));
}

interface Side {
  edge: XmlElement;
  other: XmlElement;
}

function contentEnd(doc: XmlDocument, id: string | null, skip: XmlElement): XmlElement | null {
  if (!id) return null;
  const cell = findCellById(doc, id);
  if (!cell || cell === skip || !isContentVertex(cell)) return null;
  return cell;
}

function sidesOf(doc: XmlDocument, vertex: XmlElement): { incoming: Side[]; outgoing: Side[] } {
  const id = vertex.getAttribute("id");
  const incoming: Side[] = [];
  const outgoing: Side[] = [];
  for (const edge of listEdges(doc)) {
    if (edge.getAttribute("target") === id) {
      const other = contentEnd(doc, edge.getAttribute("source"), vertex);
      if (other) incoming.push({ edge, other });
    } else if (edge.getAttribute("source") === id) {
      const other = contentEnd(doc, edge.getAttribute("target"), vertex);
      if (other) outgoing.push({ edge, other });
    }
  }
  return { incoming, outgoing };
}

function removeVertex(doc: XmlDocument, target: XmlElement) {
  const id = target.getAttribute("id");
  const cells = doc.getElementsByTagName("mxCell");
  const attached: XmlElement[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (!cell || cell === target) continue;
    if (cell.getAttribute("parent") === id || cell.getAttribute("source") === id || cell.getAttribute("target") === id) {
      attached.push(cell);
    }
  }
  for (const cell of attached) cell.parentNode?.removeChild(cell);
  target.parentNode?.removeChild(target);
}

function survivorEnds(
  doc: XmlDocument,
  vertex: XmlElement,
  direction: "in" | "out",
  doomed: Set<XmlElement>,
): XmlElement[] {
  const { incoming, outgoing } = sidesOf(doc, vertex);
  const sides = direction === "in" ? incoming : outgoing;
  const found: XmlElement[] = [];
  for (const side of sides) {
    const end = doomed.has(side.other) ? nearestNeighbor(doc, side.other, direction, doomed) : side.other;
    if (end && !found.includes(end)) found.push(end);
  }
  return found;
}

function nearestNeighbor(
  doc: XmlDocument,
  vertex: XmlElement,
  direction: "in" | "out",
  doomed: Set<XmlElement>,
  seen = new Set<XmlElement>(),
): XmlElement | null {
  if (seen.has(vertex)) return null;
  seen.add(vertex);
  const { incoming, outgoing } = sidesOf(doc, vertex);
  const sides = direction === "in" ? incoming : outgoing;
  for (const side of sides) {
    if (!doomed.has(side.other)) return side.other;
  }
  for (const side of sides) {
    const further = nearestNeighbor(doc, side.other, direction, doomed, seen);
    if (further) return further;
  }
  return null;
}

function putEdgeLabel(doc: XmlDocument, from: XmlElement, to: XmlElement, label: string, written: Set<XmlElement>) {
  let edge = findEdgeBetween(doc, from, to);
  if (!edge) {
    connectCells(doc, from, to, label);
    edge = findEdgeBetween(doc, from, to);
    if (edge) written.add(edge);
    return;
  }
  const current = edge.getAttribute("value") ?? "";
  if (written.has(edge)) {
    if (current && !current.split(/,\s*/).includes(label)) edge.setAttribute("value", `${current}, ${label}`);
    else if (!current) edge.setAttribute("value", label);
    return;
  }
  edge.setAttribute("value", label);
  written.add(edge);
}

interface LabelMove {
  name: string;
  from: string;
  to: string;
}

function promoteVertices(doc: XmlDocument, vertices: XmlElement[]): { moves: LabelMove[]; stuck: string[] } {
  const doomed = new Set(vertices);
  const ordered = [...vertices].sort((left, right) => absoluteGeometry(left).x - absoluteGeometry(right).x);
  const bridges: Array<{ vertex: XmlElement; from: XmlElement; to: XmlElement }> = [];
  const leaves: Array<{ vertex: XmlElement; edge: XmlElement }> = [];
  const stuck: string[] = [];
  for (const vertex of ordered) {
    const left = nearestNeighbor(doc, vertex, "in", doomed);
    const right = nearestNeighbor(doc, vertex, "out", doomed);
    if (left && right && left !== right) {
      bridges.push({ vertex, from: left, to: right });
      continue;
    }
    const neighbor = left ?? right;
    if (!neighbor) {
      stuck.push(cellLabel(vertex));
      continue;
    }
    const neighborId = neighbor.getAttribute("id");
    const doomedIds = new Set([...doomed].map((item) => item.getAttribute("id")));
    const others = listEdges(doc).filter((edge) => {
      const source = edge.getAttribute("source");
      const target = edge.getAttribute("target");
      const touchesNeighbor = source === neighborId || target === neighborId;
      const otherId = source === neighborId ? target : target === neighborId ? source : null;
      return touchesNeighbor && Boolean(otherId) && !doomedIds.has(otherId);
    });
    const best = others.find((edge) => edge.getAttribute("target") === neighborId) ?? others[0];
    if (!best) {
      stuck.push(cellLabel(vertex));
      continue;
    }
    leaves.push({ vertex, edge: best });
  }
  const written = new Set<XmlElement>();
  const moves: LabelMove[] = [];
  for (const bridge of bridges) {
    const name = cellLabel(bridge.vertex);
    putEdgeLabel(doc, bridge.from, bridge.to, name, written);
    for (const source of survivorEnds(doc, bridge.vertex, "in", doomed)) {
      for (const target of survivorEnds(doc, bridge.vertex, "out", doomed)) {
        if (source === target || (source === bridge.from && target === bridge.to)) continue;
        connectCells(doc, source, target, "");
      }
    }
    moves.push({ name, from: cellLabel(bridge.from), to: cellLabel(bridge.to) });
  }
  for (const leaf of leaves) {
    const name = cellLabel(leaf.vertex);
    const current = leaf.edge.getAttribute("value") ?? "";
    if (written.has(leaf.edge) && current && !current.split(/,\s*/).includes(name)) leaf.edge.setAttribute("value", `${current}, ${name}`);
    else leaf.edge.setAttribute("value", name);
    written.add(leaf.edge);
    const fromCell = findCellById(doc, leaf.edge.getAttribute("source") ?? "");
    const toCell = findCellById(doc, leaf.edge.getAttribute("target") ?? "");
    moves.push({
      name,
      from: fromCell ? cellLabel(fromCell) : "",
      to: toCell ? cellLabel(toCell) : "",
    });
  }
  for (const move of moves) {
    const vertex = ordered.find((item) => cellLabel(item) === move.name);
    if (vertex) removeVertex(doc, vertex);
  }
  return { moves, stuck };
}

function movedReply(moves: LabelMove[]): string {
  const groups = new Map<string, { from: string; to: string; names: string[] }>();
  for (const move of moves) {
    const key = `${move.from}\0${move.to}`;
    const group = groups.get(key) ?? { from: move.from, to: move.to, names: [] };
    if (!group.names.includes(move.name)) group.names.push(move.name);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const names = group.names.map((name) => `"${name}"`).join(" and ");
      if (group.from && group.to) return `Moved ${names} onto the edge between ${group.from} and ${group.to}.`;
      return `Moved ${names} onto the connecting edge.`;
    })
    .join(" ");
}

function labelDecision(reply: string, slots: DiagramSlots = {}, intent: KevDecision["intent"] = "clarify"): KevDecision {
  return { intent, reply, slots, operations: [], updatedXml: null };
}

/**
 * Host edit: the named vertex's text becomes the label of the best connecting
 * edge, neighbors are reconnected, and the vertex is removed.
 * Null when the message is not that request.
 */
export function nodeToEdgeLabelTurn(
  message: string,
  xml: string,
  earlier = "",
): { decision: KevDecision; xml: string } | null {
  let parsed = parseNodeToEdgeLabel(message);
  if (!parsed && isBareShapeName(message) && parseNodeToEdgeLabel(earlier)) {
    parsed = { queries: splitNodeNames(message) };
  }
  if (!parsed) return null;
  let doc: XmlDocument;
  try {
    doc = openDiagram(xml);
  } catch {
    return null;
  }
  let queries = parsed.queries;
  if (queries.length === 0) {
    const prior = earlier ? parseNodeToEdgeLabel(earlier) : null;
    if (prior && prior.queries.length > 0) queries = prior.queries;
  }
  const vertices: XmlElement[] = [];
  const missing: string[] = [];
  if (queries.length === 0) {
    const vertex = resolveLabelVertex(doc, null, earlier);
    if (vertex) vertices.push(vertex);
    else missing.push("that node");
  } else {
    for (const query of queries) {
      const vertex = findContentVertex(doc, query);
      if (vertex && !vertices.includes(vertex)) vertices.push(vertex);
      else if (!vertex) missing.push(query);
    }
  }
  if (vertices.length === 0) {
    const name = missing[0] && missing[0] !== "that node" ? missing.join(" or ") : "that node";
    return {
      decision: labelDecision(missing[0] === "that node" ? "I don't see a node to turn into a label." : `I don't see ${name} on the diagram.`),
      xml,
    };
  }
  const promoted = promoteVertices(doc, vertices);
  if (promoted.moves.length === 0) {
    const name = promoted.stuck[0] ?? cellLabel(vertices[0]!);
    return {
      decision: labelDecision(`${name} has to sit between two shapes before it can become an edge label.`),
      xml,
    };
  }
  polishDiagram(doc);
  const next = serializeDiagram(doc);
  const primary = promoted.moves[0]!;
  return {
    decision: labelDecision(movedReply(promoted.moves), {
      target: primary.name,
      edgeLabel: primary.name,
      from: primary.from || null,
      to: primary.to || null,
    }, "delete_shape"),
    xml: next,
  };
}
