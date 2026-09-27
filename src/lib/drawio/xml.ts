import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement } from "@xmldom/xmldom";
import zlib from "node:zlib";

export class DiagramXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramXmlError";
  }
}

export interface VertexSummary {
  id: string;
  label: string;
  x: number;
  y: number;
  style: string;
}

export interface EdgeSummary {
  from: string;
  to: string;
  label: string;
}

export interface DiagramSummary {
  vertices: VertexSummary[];
  edges: EdgeSummary[];
}

const ELEMENT_NODE = 1;

export function plainLabel(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function decompressDrawio(data: string): string {
  const cleaned = data.replace(/\s+/g, "");
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) {
    throw new DiagramXmlError("Diagram XML compression could not be decoded.");
  }
  let inflated: Buffer;
  try {
    inflated = zlib.inflateRawSync(bytes);
  } catch {
    try {
      inflated = zlib.inflateSync(bytes);
    } catch {
      throw new DiagramXmlError("Diagram XML compression could not be decoded.");
    }
  }
  const text = inflated.toString("utf8");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function parseXml(xml: string): XmlDocument {
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) {
      throw new DiagramXmlError("Diagram XML is not well-formed.");
    }
    return doc;
  } catch (error) {
    if (error instanceof DiagramXmlError) throw error;
    throw new DiagramXmlError("Diagram XML is not well-formed.");
  }
}

function serialize(doc: XmlDocument): string {
  return new XMLSerializer().serializeToString(doc);
}

function wrapModel(modelXml: string): string {
  return `<mxfile host="embed.diagrams.net" agent="draw.ai" type="device"><diagram id="architecture" name="Architecture">${modelXml.trim()}</diagram></mxfile>`;
}

function firstElementChild(parent: XmlElement): XmlElement | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes[i];
    if (node?.nodeType === ELEMENT_NODE) return node as XmlElement;
  }
  return null;
}

function expandDiagram(doc: XmlDocument, diagram: XmlElement) {
  if (firstElementChild(diagram)) return;
  const raw = (diagram.textContent ?? "").trim();
  if (!raw) throw new DiagramXmlError("A diagram page is empty.");
  const innerXml = raw.startsWith("<") ? raw : decompressDrawio(raw);
  const inner = parseXml(innerXml);
  const model = inner.getElementsByTagName("mxGraphModel")[0];
  if (!model) {
    throw new DiagramXmlError("Compressed diagram did not contain an mxGraphModel.");
  }
  while (diagram.firstChild) diagram.removeChild(diagram.firstChild);
  diagram.appendChild(doc.importNode(model, true));
}

function assertRoots(doc: XmlDocument) {
  const cells = doc.getElementsByTagName("mxCell");
  let hasZero = false;
  let hasOne = false;
  for (let i = 0; i < cells.length; i += 1) {
    const id = cells[i]?.getAttribute("id");
    if (id === "0") hasZero = true;
    if (id === "1") hasOne = true;
  }
  if (!hasZero || !hasOne) {
    throw new DiagramXmlError("Diagram XML is missing root cells 0 and 1.");
  }
}

/** Decode compressed pages and return a well-formed mxfile draw.io can load. */
export function normalizeMxfile(xml: string): string {
  const trimmed = xml.trim();
  if (!trimmed) throw new DiagramXmlError("Diagram XML is empty.");
  const wrapped = trimmed.startsWith("<mxGraphModel") ? wrapModel(trimmed) : trimmed;
  const doc = parseXml(wrapped);
  const diagrams = doc.getElementsByTagName("diagram");
  if (diagrams.length === 0) {
    throw new DiagramXmlError("Diagram XML is missing a diagram or mxGraphModel.");
  }
  for (let i = 0; i < diagrams.length; i += 1) {
    const diagram = diagrams[i];
    if (diagram) expandDiagram(doc, diagram);
  }
  if (doc.getElementsByTagName("mxGraphModel").length === 0) {
    throw new DiagramXmlError("Diagram XML is missing an mxGraphModel.");
  }
  assertRoots(doc);
  const file = doc.getElementsByTagName("mxfile")[0];
  if (file && !file.getAttribute("agent")) file.setAttribute("agent", "draw.ai");
  return serialize(doc);
}

export function assertLoadableMxfile(xml: string): string {
  return normalizeMxfile(xml);
}

export function openDiagram(xml: string): XmlDocument {
  return parseXml(normalizeMxfile(xml));
}

export function serializeDiagram(doc: XmlDocument): string {
  return serialize(doc);
}

export function getRoot(doc: XmlDocument): XmlElement {
  const root = doc.getElementsByTagName("root")[0];
  if (!root) throw new DiagramXmlError("Diagram XML is missing a root element.");
  return root;
}

export function firstChildTag(parent: XmlElement, tag: string): XmlElement | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes[i];
    if (node?.nodeType === ELEMENT_NODE && (node as XmlElement).tagName === tag) {
      return node as XmlElement;
    }
  }
  return null;
}

export function listVertices(doc: XmlDocument): XmlElement[] {
  const cells = doc.getElementsByTagName("mxCell");
  const vertices: XmlElement[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell?.getAttribute("vertex") === "1") vertices.push(cell);
  }
  return vertices;
}

export function listEdges(doc: XmlDocument): XmlElement[] {
  const cells = doc.getElementsByTagName("mxCell");
  const edges: XmlElement[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell?.getAttribute("edge") === "1") edges.push(cell);
  }
  return edges;
}

export function cellLabel(cell: XmlElement): string {
  return plainLabel(cell.getAttribute("value"));
}

export function numberAttr(element: XmlElement | null, name: string, fallback: number): number {
  if (!element) return fallback;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : fallback;
}

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function geometryOf(cell: XmlElement): Geometry {
  const geometry = firstChildTag(cell, "mxGeometry");
  return {
    x: numberAttr(geometry, "x", 0),
    y: numberAttr(geometry, "y", 0),
    width: numberAttr(geometry, "width", 140),
    height: numberAttr(geometry, "height", 64),
  };
}

export function nextCellId(doc: XmlDocument): string {
  const cells = doc.getElementsByTagName("mxCell");
  let max = 1;
  for (let i = 0; i < cells.length; i += 1) {
    const id = Number(cells[i]?.getAttribute("id"));
    if (Number.isFinite(id)) max = Math.max(max, id);
  }
  return String(max + 1);
}

export function findCellById(doc: XmlDocument, id: string): XmlElement | null {
  const cells = doc.getElementsByTagName("mxCell");
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell?.getAttribute("id") === id) return cell;
  }
  return null;
}

export function summarizeDiagram(xml: string): DiagramSummary {
  const doc = openDiagram(xml);
  const labels = new Map<string, string>();
  const vertices = listVertices(doc).map((cell) => {
    const id = cell.getAttribute("id") ?? "";
    const label = cellLabel(cell);
    labels.set(id, label);
    const geometry = geometryOf(cell);
    return {
      id,
      label,
      x: geometry.x,
      y: geometry.y,
      style: cell.getAttribute("style") ?? "",
    };
  });
  const edges = listEdges(doc).map((cell) => ({
    from: labels.get(cell.getAttribute("source") ?? "") ?? "",
    to: labels.get(cell.getAttribute("target") ?? "") ?? "",
    label: cellLabel(cell),
  }));
  return { vertices, edges };
}
