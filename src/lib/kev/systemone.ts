import { PALETTE, SHAPE_KINDS, isShapeKind } from "@/lib/drawio/styles";
import { summarizeDiagram, type DiagramSummary } from "@/lib/drawio/xml";
import { env } from "@/lib/env";
import { KevError } from "@/lib/kev/client";
import { payloadMessage } from "@/lib/kev/parse";
import {
  ANCHOR_INSTRUCTIONS,
  ANCHOR_NONE,
  COLOR_INSTRUCTIONS,
  COLOR_NONE,
  DEPTH_CRITERIA,
  DEPTH_INSTRUCTIONS,
  DISRUPTION_INSTRUCTIONS,
  INTENT_CRITERIA,
  INTENT_INSTRUCTIONS,
  LAYOUT_CRITERIA,
  LAYOUT_INSTRUCTIONS,
  NEEDS_XML_EDIT_INSTRUCTIONS,
  PLACE_CRITERIA,
  PLACE_INSTRUCTIONS,
  SHAPE_INSTRUCTIONS,
  SHAPE_NONE,
  SOURCE_INSTRUCTIONS,
  SOURCE_NONE,
  STRATEGY_BLOCK,
  TARGET_INSTRUCTIONS,
  TARGET_NONE,
  colorCriterion,
  namedShapeCriterion,
  shapeKindCriterion,
} from "@/lib/kev/prompt-guide";
import { isIntent, type ChatMessage, type DiagramSlots, type Intent, type KevReading } from "@/lib/kev/types";

/** Jared Palmer's Kev. Local `python -m kev.serve` defaults to this name. */
export const KEV_DEFAULT_MODEL = "kev-latest";

export { INTENT_CRITERIA };

const DISRUPTION_CRITERIA = [
  "leave the diagram alone",
  "a small local edit",
  "rewire a few shapes",
  "rebuild the layout",
] as const;

const NONE = "none";
/**
 * Noul at or above this means “yes”. Shared with the diagram loop.
 * The questions are dichotomous; this cutoff stays 0.5 so a yes is still a yes.
 */
export const NOUL_YES = 0.5;

export class KevUnreachableError extends KevError {
  /** True when the call timed out. A long transcript retries once with a shorter history. */
  readonly timedOut: boolean;

  constructor(message: string, options?: { timedOut?: boolean }) {
    super(message, 502);
    this.name = "KevUnreachableError";
    this.timedOut = options?.timedOut ?? false;
  }
}

/**
 * Latest messages resent when System One rejects or times out on a transcript
 * that is too large. The first call always sends the full history. This is the
 * single retry, not a window applied on every turn.
 * Twelve messages is about six turns: an open idea, the depth question, and
 * the answer, plus a few earlier turns.
 */
export const SYSTEM_ONE_HISTORY_FALLBACK = 12;

/** The payload was rejected because it was too large. Not a host outage. */
export class SystemOnePayloadError extends KevError {
  readonly oversized = true;

  constructor(message: string) {
    super(message, 502);
    this.name = "SystemOnePayloadError";
  }
}

const OVERSIZE_TEXT =
  /payload|too large|entity too large|context length|maximum context|max(?:imum)? tokens|token limit|request size|body size|content[- ]length|too long|too big/i;

function isOversizedRejection(status: number, message: string): boolean {
  if (status === 413) return true;
  if (!OVERSIZE_TEXT.test(message)) return false;
  return status === 400 || status === 422 || status === 431 || status === 500 || status === 502 || status === 504;
}

function isRequestTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError") return true;
  if (name !== "AbortError") return false;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /timeout/i.test(message);
}

function shouldShrinkHistory(error: unknown): boolean {
  if (error instanceof SystemOnePayloadError) return true;
  return error instanceof KevUnreachableError && error.timedOut;
}

/** Oldest first. Blank lines are dropped. Null when there is nothing to show. */
function formatConversation(messages: readonly ChatMessage[] | undefined): string | null {
  if (!messages || messages.length === 0) return null;
  const lines = messages
    .map((message) => {
      const content = message.content.trim();
      if (!content) return "";
      const speaker = message.role === "assistant" ? "Assistant" : "User";
      return `${speaker}: ${content}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return null;
  return lines.join("\n");
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
    templateReference?: string | null;
    /** Full transcript, oldest first. The latest user line stays in User message. */
    history?: string | null;
    /**
     * When false, the transcript is not cut by the 12k state cap.
     * askKev uses this so a long history can be rejected and retried shorter.
     */
    clip?: boolean;
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
  const reference = notes?.templateReference?.trim();
  const history = notes?.history?.trim();
  const parts = [
    STRATEGY_BLOCK,
    `User message:\n${userMessage.trim()}`,
    history ? `Conversation:\n${history}` : "",
    reference ? `Reference:\n${reference}` : "",
    topic ? `Topic context:\n${topic}` : "",
    diff ? `Diagram diff (added, removed, and changed cells):\n${diff}` : "",
    notes?.previousXml && notes.currentXml && notes.previousXml !== notes.currentXml
      ? `Previous diagram mxfile (before the manual edit):\n${clip(notes.previousXml, 2500)}`
      : "",
    `Current diagram:\nVertices:\n${vertices}\nEdges:\n${edges}`,
    notes?.currentXml ? `Current diagram mxfile:\n${clip(notes.currentXml, 2500)}` : "",
  ].filter(Boolean);
  const state = parts.join("\n\n");
  if (notes?.clip === false) return state;
  return state.slice(0, 12_000);
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

function vertexCriteria(labels: string[], none: string): Record<string, string> {
  const criteria: Record<string, string> = { [NONE]: none };
  for (const label of labels) criteria[label] = namedShapeCriterion(label);
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
  templateReference?: string | null;
  /** Full chat, including the latest user line. Omitted from older callers. */
  messages?: readonly ChatMessage[];
  /** False on the optimistic full-history call so the server can reject a large body. */
  clip?: boolean;
}): SystemOneRequest {
  const labels = vertexLabels(input.summary);
  const shapes: Record<string, string> = { [NONE]: SHAPE_NONE };
  for (const kind of SHAPE_KINDS) shapes[kind] = shapeKindCriterion(kind);
  const colors: Record<string, string> = { [NONE]: COLOR_NONE };
  for (const name of Object.keys(PALETTE)) {
    if (name === "grey") continue;
    colors[name] = colorCriterion(name);
  }
  return {
    state: diagramState(input.userMessage, input.summary, {
      diffText: input.diagramDiff,
      previousXml: input.previousXml,
      currentXml: input.currentXml,
      topicContext: input.topicContext,
      templateReference: input.templateReference,
      history: formatConversation(input.messages),
      clip: input.clip,
    }),
    model: input.model?.trim() || KEV_DEFAULT_MODEL,
    questions: {
      intent: {
        type: "choice",
        instructions: INTENT_INSTRUCTIONS,
        criteria: { ...INTENT_CRITERIA },
      },
      needs_xml_edit: {
        type: "noul",
        instructions: NEEDS_XML_EDIT_INSTRUCTIONS,
      },
      shape: choiceQuestion(SHAPE_INSTRUCTIONS, shapes),
      color: choiceQuestion(COLOR_INSTRUCTIONS, colors),
      layout: choiceQuestion(LAYOUT_INSTRUCTIONS, LAYOUT_CRITERIA),
      place: choiceQuestion(PLACE_INSTRUCTIONS, PLACE_CRITERIA),
      anchor: choiceQuestion(ANCHOR_INSTRUCTIONS, vertexCriteria(labels, ANCHOR_NONE)),
      source: choiceQuestion(SOURCE_INSTRUCTIONS, vertexCriteria(labels, SOURCE_NONE)),
      target: choiceQuestion(TARGET_INSTRUCTIONS, vertexCriteria(labels, TARGET_NONE)),
      disruption: {
        type: "score",
        instructions: DISRUPTION_INSTRUCTIONS,
        criteria: DISRUPTION_CRITERIA,
      },
      depth: choiceQuestion(DEPTH_INSTRUCTIONS, { ...DEPTH_CRITERIA }),
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
  const depthChoice = readChoice(answers.depth)?.choice.toLowerCase();
  const depth = depthChoice === "few" || depthChoice === "many" ? depthChoice : null;

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
    depth,
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
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw new KevUnreachableError("Kev is unreachable.", { timedOut: true });
    }
    throw new KevUnreachableError("Kev is unreachable.");
  }

  if (response.status === 408) {
    throw new KevUnreachableError("Kev is unreachable (408).", { timedOut: true });
  }

  if (!response.ok) {
    const failed: unknown = await response.json().catch(() => null);
    const message = payloadMessage(failed, `Kev failed (${response.status}).`);
    if (isOversizedRejection(response.status, message)) throw new SystemOnePayloadError(message);
    if (UNREACHABLE.has(response.status)) {
      throw new KevUnreachableError(`Kev is unreachable (${response.status}).`);
    }
    throw new KevError(message, 502);
  }

  const payload: unknown = await response.json().catch(() => null);
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
    templateReference?: string | null;
    /** Full chat. The first call sends every message; a size failure retries the latest few. */
    messages?: readonly ChatMessage[];
  },
  options?: { timeoutMs?: number },
): Promise<KevReading> {
  const history = input.messages ?? [];
  try {
    return await askKevOnce(input, history, options?.timeoutMs);
  } catch (error) {
    if (history.length <= SYSTEM_ONE_HISTORY_FALLBACK || !shouldShrinkHistory(error)) throw error;
    return askKevOnce(input, history.slice(-SYSTEM_ONE_HISTORY_FALLBACK), options?.timeoutMs);
  }
}

async function askKevOnce(
  input: {
    userMessage: string;
    currentXml: string;
    previousXml?: string | null;
    diagramDiff?: string;
    topicContext?: string | null;
    templateReference?: string | null;
  },
  messages: readonly ChatMessage[],
  timeoutMs?: number,
): Promise<KevReading> {
  let summary: DiagramSummary = { vertices: [], edges: [] };
  try {
    summary = summarizeDiagram(input.currentXml);
  } catch {
    summary = { vertices: [], edges: [] };
  }
  const model = env("KEV_MODEL") ?? KEV_DEFAULT_MODEL;
  // Leave the state unclipped so a long transcript reaches System One intact.
  // A size rejection or timeout retries once with SYSTEM_ONE_HISTORY_FALLBACK.
  const body = buildSystemOneRequest({
    userMessage: input.userMessage,
    summary,
    model,
    currentXml: input.currentXml,
    previousXml: input.previousXml,
    diagramDiff: input.diagramDiff,
    topicContext: input.topicContext,
    templateReference: input.templateReference,
    messages,
    clip: false,
  });

  const payload = await callSystemOne(body, timeoutMs ?? 50_000);
  try {
    const reading = parseSystemOneResponse(payload, vertexLabels(summary));
    if (!reading.model) reading.model = model;
    return reading;
  } catch (error) {
    if (error instanceof KevUnreachableError) throw error;
    throw new KevUnreachableError("Kev returned an unreadable System One response.");
  }
}
