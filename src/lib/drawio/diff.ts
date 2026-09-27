import { openDiagram, plainLabel } from "@/lib/drawio/xml";

export interface CellChange {
  id: string;
  kind: string;
  value: string;
  previousValue: string;
  fields: string[];
}

export interface DiagramDiff {
  added: Array<{ id: string; kind: string; value: string }>;
  removed: Array<{ id: string; kind: string; value: string }>;
  changed: CellChange[];
  note?: string;
}

interface CellSnap {
  id: string;
  kind: string;
  value: string;
  style: string;
  source: string;
  target: string;
  x: string;
  y: string;
  width: string;
  height: string;
}

const ROOT_IDS = new Set(["0", "1"]);

function kindOf(vertex: string | null, edge: string | null): string {
  if (vertex === "1") return "vertex";
  if (edge === "1") return "edge";
  return "cell";
}

function snapshot(xml: string): Map<string, CellSnap> {
  const doc = openDiagram(xml);
  const cells = doc.getElementsByTagName("mxCell");
  const map = new Map<string, CellSnap>();
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (!cell) continue;
    const id = cell.getAttribute("id") ?? "";
    if (!id || ROOT_IDS.has(id)) continue;
    const geometry = childTag(cell, "mxGeometry");
    map.set(id, {
      id,
      kind: kindOf(cell.getAttribute("vertex"), cell.getAttribute("edge")),
      value: plainLabel(cell.getAttribute("value")),
      style: cell.getAttribute("style") ?? "",
      source: cell.getAttribute("source") ?? "",
      target: cell.getAttribute("target") ?? "",
      x: geometry?.getAttribute("x") ?? "",
      y: geometry?.getAttribute("y") ?? "",
      width: geometry?.getAttribute("width") ?? "",
      height: geometry?.getAttribute("height") ?? "",
    });
  }
  return map;
}

function childTag(parent: import("@xmldom/xmldom").Element, tag: string) {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes[i];
    if (node?.nodeType === 1 && (node as import("@xmldom/xmldom").Element).tagName === tag) {
      return node as import("@xmldom/xmldom").Element;
    }
  }
  return null;
}

function changedFields(before: CellSnap, after: CellSnap): string[] {
  const fields: string[] = [];
  if (before.value !== after.value) fields.push("value");
  if (before.style !== after.style) fields.push("style");
  if (before.source !== after.source) fields.push("source");
  if (before.target !== after.target) fields.push("target");
  if (before.kind !== after.kind) fields.push("kind");
  if (before.x !== after.x || before.y !== after.y) fields.push("position");
  if (before.width !== after.width || before.height !== after.height) fields.push("size");
  return fields;
}

/** Added, removed, and changed mxCell ids between the pre-edit diagram and the live one. */
export function diffDiagrams(previousXml: string | null | undefined, currentXml: string): DiagramDiff {
  if (!previousXml || !previousXml.trim() || previousXml === currentXml) {
    return { added: [], removed: [], changed: [], note: "No manual edits since the last applied diagram." };
  }
  let before: Map<string, CellSnap>;
  let after: Map<string, CellSnap>;
  try {
    before = snapshot(previousXml);
    after = snapshot(currentXml);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The diagram diff could not be read.";
    return { added: [], removed: [], changed: [], note: message };
  }

  const added: DiagramDiff["added"] = [];
  const removed: DiagramDiff["removed"] = [];
  const changed: CellChange[] = [];

  for (const [id, cell] of after) {
    const prior = before.get(id);
    if (!prior) {
      added.push({ id, kind: cell.kind, value: cell.value });
      continue;
    }
    const fields = changedFields(prior, cell);
    if (fields.length > 0) {
      changed.push({ id, kind: cell.kind, value: cell.value, previousValue: prior.value, fields });
    }
  }
  for (const [id, cell] of before) {
    if (!after.has(id)) removed.push({ id, kind: cell.kind, value: cell.value });
  }

  added.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  removed.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  changed.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return { added, removed, changed, note: "No cell changes since the previous diagram." };
  }
  return { added, removed, changed };
}

function labelOf(value: string): string {
  return value ? JSON.stringify(value) : "(unlabeled)";
}

/** Short text for the Kev state and the XML-writer prompt. */
export function formatDiagramDiff(diff: DiagramDiff): string {
  if (diff.note && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return diff.note;
  }
  const lines: string[] = [];
  const added = diff.added.slice(0, 24);
  const removed = diff.removed.slice(0, 24);
  const changed = diff.changed.slice(0, 24);
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return diff.note ?? "No cell changes since the previous diagram.";
  }
  if (added.length > 0) {
    lines.push("Added:");
    for (const cell of added) lines.push(`- id ${cell.id} ${cell.kind} ${labelOf(cell.value)}`);
  }
  if (removed.length > 0) {
    lines.push("Removed:");
    for (const cell of removed) lines.push(`- id ${cell.id} ${cell.kind} ${labelOf(cell.value)}`);
  }
  if (changed.length > 0) {
    lines.push("Changed:");
    for (const cell of changed) {
      const value =
        cell.fields.includes("value") && cell.previousValue !== cell.value
          ? ` value ${labelOf(cell.previousValue)} → ${labelOf(cell.value)}`
          : ` value ${labelOf(cell.value)}`;
      lines.push(`- id ${cell.id} ${cell.kind}${value}; ${cell.fields.join(", ")}`);
    }
  }
  const hidden = diff.added.length + diff.removed.length + diff.changed.length - added.length - removed.length - changed.length;
  if (hidden > 0) lines.push(`… ${hidden} more cell changes omitted`);
  return lines.join("\n");
}

function clipXml(xml: string, max: number): string {
  if (xml.length <= max) return xml;
  return `${xml.slice(0, max)}\n… truncated ${xml.length - max} characters`;
}

/**
 * Prompt block: previous mxfile (when the user edited by hand), the live mxfile, and the cell diff.
 * Current XML is included in full up to `maxXml` so a normal diagram is not cut.
 */
export function formatDiagramContext(input: {
  currentXml: string;
  previousXml?: string | null;
  diffText: string;
  maxXml?: number;
}): string {
  const maxXml = input.maxXml ?? 120_000;
  const parts: string[] = [];
  if (input.previousXml && input.previousXml.trim() && input.previousXml !== input.currentXml) {
    parts.push(`Previous diagram mxfile (last known before the latest manual edit):\n${clipXml(input.previousXml, maxXml)}`);
  }
  parts.push(`Current diagram mxfile:\n${clipXml(input.currentXml, maxXml)}`);
  parts.push(`Diagram diff (added, removed, and changed cell ids and values):\n${input.diffText || "No cell changes since the previous diagram."}`);
  return parts.join("\n\n");
}
