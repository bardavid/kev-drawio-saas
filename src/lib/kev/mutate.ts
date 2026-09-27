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
  cellLabel,
  findCellById,
  firstChildTag,
  geometryOf,
  getRoot,
  listEdges,
  listVertices,
  nextCellId,
  numberAttr,
  openDiagram,
  serializeDiagram,
} from "@/lib/drawio/xml";
import type { DiagramOperation, DiagramSlots } from "@/lib/kev/types";

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

export function findVertex(doc: XmlDocument, query: string): XmlElement | null {
  let best: XmlElement | null = null;
  let bestScore = 0;
  for (const vertex of listVertices(doc)) {
    const score = scoreVertex(cellLabel(vertex), query);
    if (score > bestScore) {
      best = vertex;
      bestScore = score;
    }
  }
  return bestScore >= 50 ? best : null;
}

function requireVertex(doc: XmlDocument, query: string): XmlElement {
  const found = findVertex(doc, query);
  if (!found) {
    throw new DiagramXmlError(`I couldn't find a shape named “${query}”.`);
  }
  return found;
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
  let moved = false;
  for (const vertex of listVertices(doc)) {
    const geometry = firstChildTag(vertex, "mxGeometry");
    if (!geometry) continue;
    const x = numberAttr(geometry, "x", 0);
    if (x >= minX - 0.5) {
      geometry.setAttribute("x", String(Math.round(x + dx)));
      moved = true;
    }
  }
  if (moved) clearEdgeWaypoints(doc);
}

function connectCells(doc: XmlDocument, source: XmlElement, target: XmlElement, label: string) {
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
  cell.setAttribute("style", EDGE_STYLE);
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
): XmlElement {
  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", nextCellId(doc));
  cell.setAttribute("value", label);
  cell.setAttribute("style", style);
  cell.setAttribute("vertex", "1");
  cell.setAttribute("parent", "1");
  const geometry = doc.createElement("mxGeometry");
  geometry.setAttribute("x", String(Math.round(x)));
  geometry.setAttribute("y", String(Math.round(Math.max(40, y))));
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

  if (slots.place === "before") {
    const query = slots.target || slots.to;
    if (!query) throw new DiagramXmlError("Say which shape to insert in front of.");
    beforeAnchor = requireVertex(doc, query);
    const anchor = geometryOf(beforeAnchor);
    x = anchor.x;
    y = anchor.y + Math.round((anchor.height - size.height) / 2);
    shiftRightOf(doc, anchor.x, size.width + 80);
  } else if (slots.from || slots.place === "after") {
    const query = slots.from || slots.target;
    if (!query) throw new DiagramXmlError("Say which shape to connect from.");
    fromAnchor = requireVertex(doc, query);
    const anchor = geometryOf(fromAnchor);
    x = anchor.x + anchor.width + 80;
    y = anchor.y + Math.round((anchor.height - size.height) / 2);
    shiftRightOf(doc, x, size.width + 40);
  } else if (slots.to) {
    toAnchor = requireVertex(doc, slots.to);
    const anchor = geometryOf(toAnchor);
    x = Math.max(40, anchor.x - size.width - 80);
    y = anchor.y + Math.round((anchor.height - size.height) / 2);
  } else {
    let maxRight = 40;
    for (const vertex of listVertices(doc)) {
      const anchor = geometryOf(vertex);
      maxRight = Math.max(maxRight, anchor.x + anchor.width + 80);
    }
    x = maxRight;
  }

  const cell = createVertex(doc, label, style, x, y, size.width, size.height);

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

function styleShapes(doc: XmlDocument, slots: DiagramSlots) {
  const palette = resolvePalette(slots);
  if (!palette.fill && !palette.stroke) {
    throw new DiagramXmlError("Name a color, for example “Make the API red.”");
  }
  const query = slots.target || slots.label;
  const vertices = query ? [requireVertex(doc, query)] : listVertices(doc);
  if (vertices.length === 0) throw new DiagramXmlError("There are no shapes to restyle.");
  for (const vertex of vertices) {
    vertex.setAttribute(
      "style",
      applyColors(vertex.getAttribute("style") || SHAPE_STYLE.rectangle, palette.fill, palette.stroke, palette.font),
    );
  }
}

function layoutDiagram(doc: XmlDocument, slots: DiagramSlots) {
  const vertical = slots.layout === "vertical";
  const vertices = [...listVertices(doc)].sort((a, b) => {
    const left = geometryOf(a);
    const right = geometryOf(b);
    if (vertical) return left.y - right.y || left.x - right.x;
    return left.x - right.x || left.y - right.y;
  });
  let cursor = 80;
  for (const vertex of vertices) {
    const geometry = firstChildTag(vertex, "mxGeometry");
    if (!geometry) continue;
    const width = numberAttr(geometry, "width", 140);
    const height = numberAttr(geometry, "height", 64);
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
  return serializeDiagram(doc);
}
