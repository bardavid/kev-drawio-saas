export const SHAPE_KINDS = [
  "rectangle",
  "ellipse",
  "diamond",
  "cylinder",
  "cloud",
  "actor",
  "hexagon",
  "document",
  "queue",
] as const;

export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const SHAPE_STYLE: Record<ShapeKind, string> = {
  rectangle: "rounded=1;whiteSpace=wrap;html=1;arcSize=10;",
  ellipse: "ellipse;whiteSpace=wrap;html=1;",
  diamond: "rhombus;whiteSpace=wrap;html=1;",
  cylinder:
    "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;",
  cloud: "ellipse;shape=cloud;whiteSpace=wrap;html=1;",
  actor:
    "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;",
  hexagon:
    "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;",
  document: "shape=document;whiteSpace=wrap;html=1;boundedLbl=1;",
  queue: "shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;size=0.14;",
};

export const SHAPE_SIZE: Record<ShapeKind, { width: number; height: number }> = {
  rectangle: { width: 150, height: 64 },
  ellipse: { width: 140, height: 72 },
  diamond: { width: 150, height: 84 },
  cylinder: { width: 140, height: 80 },
  cloud: { width: 160, height: 96 },
  actor: { width: 48, height: 80 },
  hexagon: { width: 150, height: 76 },
  document: { width: 150, height: 84 },
  queue: { width: 160, height: 64 },
};

export interface PaletteColor {
  fill: string;
  stroke: string;
  font?: string;
}

export const PALETTE: Record<string, PaletteColor> = {
  blue: { fill: "#dae8fc", stroke: "#6c8ebf" },
  green: { fill: "#d5e8d4", stroke: "#82b366" },
  orange: { fill: "#ffe6cc", stroke: "#d79b00" },
  yellow: { fill: "#fff2cc", stroke: "#d6b656" },
  red: { fill: "#f8cecc", stroke: "#b85450" },
  purple: { fill: "#e1d5e7", stroke: "#9673a6" },
  gray: { fill: "#f5f5f5", stroke: "#666666" },
  grey: { fill: "#f5f5f5", stroke: "#666666" },
  teal: { fill: "#d5e8e4", stroke: "#0e8088" },
  cyan: { fill: "#c5f6fa", stroke: "#0c8599" },
  pink: { fill: "#fad7e4", stroke: "#c45c7a" },
  black: { fill: "#1f2937", stroke: "#111827", font: "#ffffff" },
  white: { fill: "#ffffff", stroke: "#94a3b8" },
};

const KIND_COLOR: Record<ShapeKind, string> = {
  rectangle: "green",
  ellipse: "purple",
  diamond: "yellow",
  cylinder: "blue",
  cloud: "teal",
  actor: "gray",
  hexagon: "orange",
  document: "yellow",
  queue: "orange",
};

export const EDGE_STYLE =
  "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=classic;endFill=1;strokeColor=#64748b;fontColor=#334155;";

export function isShapeKind(value: string | null | undefined): value is ShapeKind {
  return !!value && (SHAPE_KINDS as readonly string[]).includes(value);
}

export function inferShape(label: string): ShapeKind {
  const text = label.toLowerCase();
  if (/\b(postgres|postgresql|mysql|mariadb|mongo|mongodb|sqlite|dynamo|redis|memcached|replica|database)\b|\bdb\b/.test(text)) {
    return "cylinder";
  }
  if (/\b(s3|blob|bucket|storage)\b/.test(text)) return "cloud";
  if (/\b(kafka|sqs|rabbit|queue|pubsub|nats)\b/.test(text)) return "queue";
  if (/\b(user|actor|person|customer|admin)\b/.test(text)) return "actor";
  if (/\b(decision|gateway)\b/.test(text)) return "diamond";
  if (/\b(document|spec|pdf)\b/.test(text)) return "document";
  return "rectangle";
}

export function inferColorName(label: string, kind: ShapeKind): string {
  const text = label.toLowerCase();
  if (/\bredis\b/.test(text)) return "red";
  if (/\b(postgres|postgresql|replica)\b/.test(text)) return "blue";
  if (/\b(client|browser|web)\b/.test(text)) return "orange";
  if (/\b(api|service|server|auth)\b/.test(text)) return "green";
  return KIND_COLOR[kind];
}

export function parseStyle(style: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of style.split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) map.set(part, "");
    else map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return map;
}

export function stringifyStyle(style: Map<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of style) {
    parts.push(value === "" ? key : `${key}=${value}`);
  }
  return `${parts.join(";")};`;
}

export function applyColors(
  style: string,
  fill?: string | null,
  stroke?: string | null,
  font?: string | null,
): string {
  const map = parseStyle(style);
  if (fill) map.set("fillColor", fill);
  if (stroke) map.set("strokeColor", stroke);
  if (font) map.set("fontColor", font);
  return stringifyStyle(map);
}
