import { PALETTE, SHAPE_KINDS, isShapeKind } from "@/lib/drawio/styles";
import { summarizeDiagram, type DiagramSummary } from "@/lib/drawio/xml";
import { env } from "@/lib/env";
import { KevError } from "@/lib/kev/client";
import { payloadMessage } from "@/lib/kev/parse";
import { isIntent, type DiagramSlots, type Intent, type KevReading } from "@/lib/kev/types";

/** Jared Palmer's Kev. Local `python -m kev.serve` defaults to this name. */
export const KEV_DEFAULT_MODEL = "kev-latest";

export const INTENT_CRITERIA = {
  add_shape: "Add a new vertex/shape",
  edit_shape: "Change an existing shape’s label or style",
  delete_shape: "Remove a shape",
  connect: "Add an edge between shapes",
  layout: "Rearrange positions",
  style: "Restyle without changing topology",
  clarify: "Need more info from the user",
  noop: "No diagram change",
} as const;

const DISRUPTION_CRITERIA = [
  "leave the diagram alone",
  "a small local edit",
  "rewire a few shapes",
  "rebuild the layout",
] as const;

const NONE = "none";
/** Noul at or above this means “yes”. Shared with the diagram loop. */
export const NOUL_YES = 0.5;

export class KevUnreachableError extends KevError {
  constructor(message: string) {
    super(message, 502);
    this.name = "KevUnreachableError";
  }
}

export interface SystemOneQuestion {
  type: "choice" | "noul" | "score";
  instructions: string;
  criteria?: Record<string, string> | readonly string[];
}

/** Body for POST /v1/systemone. */
export interface SystemOneRequest {
  state: string;
  model: string;
  questions: Record<string, SystemOneQuestion>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clip(xml: string, max: number): string {
  if (xml.length <= max) return xml;
  return `${xml.slice(0, max)}\n… truncated`;
}

export function diagramState(
  userMessage: string,
  summary: DiagramSummary,
  notes?: {
    diffText?: string;
    previousXml?: string | null;
    currentXml?: string;
    topicContext?: string | null;
  },
): string {
  const vertices =
    summary.vertices
      .map((vertex) => `- ${vertex.label || "(unlabeled)"} at (${Math.round(vertex.x)}, ${Math.round(vertex.y)})`)
      .join("\n") || "- (none)";
  const edges =
    summary.edges
      .map((edge) => `- ${edge.from || "?"} → ${edge.to || "?"}${edge.label ? ` (${edge.label})` : ""}`)
      .join("\n") || "- (none)";
  const diff = notes?.diffText?.trim();
  const topic = notes?.topicContext?.trim();
  const parts = [
    "The host places shapes and routes edges. Answer the questions. Do not invent coordinates or XML.",
    `User message:\n${userMessage.trim()}`,
    topic ? `Topic context:\n${topic}` : "",
    diff ? `Diagram diff (added, removed, and changed cells):\n${diff}` : "",
    notes?.previousXml && notes.currentXml && notes.previousXml !== notes.currentXml
      ? `Previous diagram mxfile (before the manual edit):\n${clip(notes.previousXml, 2500)}`
      : "",
    `Current diagram:\nVertices:\n${vertices}\nEdges:\n${edges}`,
    notes?.currentXml ? `Current diagram mxfile:\n${clip(notes.currentXml, 2500)}` : "",
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 12_000);
}

export function vertexLabels(summary: DiagramSummary): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const vertex of summary.vertices) {
    const label = vertex.label.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length >= 24) break;
  }
  return labels;
}

function choiceQuestion(instructions: string, criteria: Record<string, string>): SystemOneQuestion {
  return { type: "choice", instructions, criteria };
}

function vertexCriteria(labels: string[]): Record<string, string> {
  const criteria: Record<string, string> = { [NONE]: "None of the current shapes" };
  for (const label of labels) criteria[label] = `The shape labeled ${label}`;
  return criteria;
}

/**
 * Questions Kev can answer from a closed set.
 * `intent` and `needs_xml_edit` match the product contract.
 * The other choices are slots. `disruption` is a score (low → high).
 */
export function buildSystemOneRequest(input: {
  userMessage: string;
  summary: DiagramSummary;
  model?: string;
  currentXml?: string;
  previousXml?: string | null;
  diagramDiff?: string;
  topicContext?: string | null;
}): SystemOneRequest {
  const labels = vertexLabels(input.summary);
  const shapes: Record<string, string> = { [NONE]: "Do not choose a shape kind" };
  for (const kind of SHAPE_KINDS) shapes[kind] = `Draw the vertex as a ${kind}`;
  const colors: Record<string, string> = { [NONE]: "Do not change color" };
  for (const name of Object.keys(PALETTE)) {
    if (name === "grey") continue;
    colors[name] = `Use the ${name} palette`;
  }
  const vertices = vertexCriteria(labels);
  return {
    state: diagramState(input.userMessage, input.summary, {
      diffText: input.diagramDiff,
      previousXml: input.previousXml,
      currentXml: input.currentXml,
      topicContext: input.topicContext,
    }),
    model: input.model?.trim() || KEV_DEFAULT_MODEL,
    questions: {
      intent: {
        type: "choice",
        instructions:
          "What diagram edit does the user want? Recoloring every box, including “change the boxes to red”, is style. A bare draw with no subject is clarify.",
        criteria: { ...INTENT_CRITERIA },
      },
      needs_xml_edit: {
        type: "noul",
        instructions: "Should the diagram XML be modified?",
      },
      shape: choiceQuestion("Which shape kind should be used, if any?", shapes),
      color: choiceQuestion(
        "Which named color should fills use? Choose none when the user did not name a color. “Change the boxes to red” is red.",
        colors,
      ),
      layout: choiceQuestion("How should shapes be arranged, if the user asked for a layout? Choose none when the host should place shapes.", {
        horizontal: "Lay shapes in a horizontal row",
        vertical: "Lay shapes in a vertical column",
        none: "Do not rearrange",
      }),
      place: choiceQuestion("Where should a new shape sit relative to an existing one?", {
        before: "In front of the anchor, on the incoming side",
        after: "Behind the anchor, on the outgoing side",
        none: "No relative placement",
      }),
      anchor: choiceQuestion(
        "Which existing shape is the subject of this edit? Choose none when every box should change.",
        vertices,
      ),
      source: choiceQuestion("Which existing shape is the edge source, if any?", vertices),
      target: choiceQuestion("Which existing shape is the edge target, if any?", vertices),
      disruption: {
        type: "score",
        instructions: "How much of the current diagram should change?",
        criteria: DISRUPTION_CRITERIA,
      },
    },
  };
}

/** Noul is P(yes). Clarify and noop never edit, even when the noul is high. */
export function needsXmlEdit(intent: Intent, noul: number | null): boolean {
  if (intent === "clarify" || intent === "noop") return false;
  if (noul === null) return true;
  return noul >= NOUL_YES;
}

function readChoice(value: unknown): { choice: string; confidence: number | null } | null {
  const record = asRecord(value);
  if (!record || record.type !== "choice" || typeof record.choice !== "string" || !record.choice.trim()) return null;
  return {
    choice: record.choice.trim(),
    confidence: typeof record.confidence === "number" ? record.confidence : null,
  };
}

function readNoul(value: unknown): number | null {
  const record = asRecord(value);
  if (!record || record.type !== "noul" || typeof record.noul !== "number" || Number.isNaN(record.noul)) return null;
  return record.noul;
}

function readScore(value: unknown): { score: number; legend: string | null } | null {
  const record = asRecord(value);
  if (!record || record.type !== "score" || typeof record.score !== "number" || Number.isNaN(record.score)) return null;
  let legend: string | null = null;
  if (typeof record.legend === "string" && record.legend.trim()) legend = record.legend.trim();
  else if (Array.isArray(record.legend)) {
    const item = record.legend[record.score];
    if (typeof item === "string" && item.trim()) legend = item.trim();
  }
  return { score: record.score, legend };
}

function namedVertex(choice: string | undefined, labels: string[]): string | null {
  if (!choice || choice.toLowerCase() === NONE) return null;
  return labels.find((label) => label.toLowerCase() === choice.toLowerCase()) ?? null;
}

export function parseSystemOneResponse(payload: unknown, labels: string[]): KevReading {
  const record = asRecord(payload);
  const answers = record ? asRecord(record.answers) : null;
  if (!answers) throw new KevError("Kev returned an unreadable System One response.", 502);

  const intentAnswer = readChoice(answers.intent);
  const intent: Intent = intentAnswer && isIntent(intentAnswer.choice) ? intentAnswer.choice : "clarify";
  const noul = readNoul(answers.needs_xml_edit);
  const shape = readChoice(answers.shape)?.choice;
  const color = readChoice(answers.color)?.choice;
  const layout = readChoice(answers.layout)?.choice;
  const place = readChoice(answers.place)?.choice;
  const score = readScore(answers.disruption);

  const slots: DiagramSlots = {
    shape: shape && isShapeKind(shape) ? shape : null,
    colorName: color && color !== NONE && Object.prototype.hasOwnProperty.call(PALETTE, color) ? color : null,
    layout: layout === "horizontal" || layout === "vertical" ? layout : null,
    place: place === "before" || place === "after" ? place : null,
    target: namedVertex(readChoice(answers.anchor)?.choice, labels),
    from: namedVertex(readChoice(answers.source)?.choice, labels),
    to: namedVertex(readChoice(answers.target)?.choice, labels),
  };

  return {
    intent,
    needsXmlEdit: needsXmlEdit(intent, noul),
    slots,
    confidence: intentAnswer?.confidence ?? null,
    disruption: score?.score ?? null,
    disruptionLegend: score?.legend ?? null,
    model: typeof record?.model === "string" && record.model.trim() ? record.model.trim() : undefined,
  };
}

const UNREACHABLE = new Set([401, 403, 404, 408, 429, 500, 502, 503, 504]);

export function systemOneAnswers(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  return record ? asRecord(record.answers) : null;
}

export function readChoiceAnswer(value: unknown): { choice: string; confidence: number | null } | null {
  return readChoice(value);
}

export function readNoulAnswer(value: unknown): number | null {
  return readNoul(value);
}

/** POST {KEV_BASE_URL}/v1/systemone. Bearer auth only when KEV_API_KEY is set. */
export async function callSystemOne(body: SystemOneRequest, timeoutMs = 50_000): Promise<unknown> {
  const base = env("KEV_BASE_URL");
  if (!base) throw new KevError("KEV_BASE_URL is not set.", 500);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = env("KEV_API_KEY");
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    throw new KevUnreachableError("Kev is unreachable.");
  }

  if (UNREACHABLE.has(response.status)) {
    throw new KevUnreachableError(`Kev is unreachable (${response.status}).`);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new KevError(payloadMessage(payload, `Kev failed (${response.status}).`), 502);
  }
  return payload;
}

/** Classify one turn with the closed-set intent questions. */
export async function askKev(
  input: {
    userMessage: string;
    currentXml: string;
    previousXml?: string | null;
    diagramDiff?: string;
    topicContext?: string | null;
  },
  options?: { timeoutMs?: number },
): Promise<KevReading> {
  let summary: DiagramSummary = { vertices: [], edges: [] };
  try {
    summary = summarizeDiagram(input.currentXml);
  } catch {
    summary = { vertices: [], edges: [] };
  }
  const model = env("KEV_MODEL") ?? KEV_DEFAULT_MODEL;
  const body = buildSystemOneRequest({
    userMessage: input.userMessage,
    summary,
    model,
    currentXml: input.currentXml,
    previousXml: input.previousXml,
    diagramDiff: input.diagramDiff,
    topicContext: input.topicContext,
  });

  const payload = await callSystemOne(body, options?.timeoutMs ?? 50_000);
  try {
    const reading = parseSystemOneResponse(payload, vertexLabels(summary));
    if (!reading.model) reading.model = model;
    return reading;
  } catch (error) {
    if (error instanceof KevUnreachableError) throw error;
    throw new KevUnreachableError("Kev returned an unreadable System One response.");
  }
}
