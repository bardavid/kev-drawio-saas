import { diffDiagrams, formatDiagramDiff } from "@/lib/drawio/diff";
import { assertLoadableMxfile, summarizeDiagram, type DiagramSummary } from "@/lib/drawio/xml";
import { env } from "@/lib/env";
import { KevError } from "@/lib/kev/client";
import {
  colorInMessage,
  CAPACITY_REPLY,
  composeOnCanvas,
  renderComposition,
  resolveComposition,
  sameMxfile,
  templateReferenceFor,
  overNamedCapacity,
} from "@/lib/kev/compose";
import { decideDemo, edgeRestyleDecision } from "@/lib/kev/demo";
import { DiagramXmlError, applyOperations, edgeQuery, groundDecision } from "@/lib/kev/mutate";
import { OPENAI_DEFAULT_MODEL, OpenAIKevClient, writeDiagramXml } from "@/lib/kev/openai";
import { maybeOrchestrate } from "@/lib/kev/orchestrate";
import { KEPT_CANVAS_REPLY, UNCHANGED_DIAGRAM_REPLY, softenUnchangedReply } from "@/lib/kev/reply";
import { architectureDecision, operationsForPlan, resolvePlan, withPalette } from "@/lib/kev/plan";
import { researchTopic, wikipediaTitle } from "@/lib/kev/research";
import { composeFromBrief, isStateMachineRequest } from "@/lib/kev/templates";
import { KEV_DEFAULT_MODEL, KevUnreachableError, askKev } from "@/lib/kev/systemone";
import {
  isMutatingIntent,
  type ChatMessage,
  type DiagramOperation,
  type DiagramSlots,
  type Intent,
  type KevDecision,
  type KevMode,
  type KevReading,
  type KevStep,
  type KevTurnResult,
} from "@/lib/kev/types";

const MAX_XML = 400_000;

export interface ModeDescription {
  mode: KevMode;
  model?: string;
  kev: boolean;
  openai: boolean;
}

export function describeMode(): ModeDescription {
  const kev = Boolean(env("KEV_BASE_URL"));
  const openai = Boolean(env("OPENAI_API_KEY"));
  if (kev) {
    return { mode: "kev", model: env("KEV_MODEL") ?? KEV_DEFAULT_MODEL, kev: true, openai };
  }
  if (openai) {
    return { mode: "openai", model: env("OPENAI_MODEL") ?? OPENAI_DEFAULT_MODEL, kev: false, openai: true };
  }
  return { mode: "demo", kev: false, openai: false };
}

function latestUser(messages: ChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

/** Lookup runs only for diagram-usage prompts, and only outside demo mode. */
async function topicContextFor(message: string, network: boolean): Promise<string | null> {
  if (!wikipediaTitle(message)) return null;
  const brief = await researchTopic(message, { network });
  return brief?.summary ?? null;
}

function editContext(currentXml: string, previousXml: string | null | undefined): { previousXml: string | null; diagramDiff: string } {
  if (!previousXml || !previousXml.trim() || previousXml === currentXml) {
    return { previousXml: null, diagramDiff: formatDiagramDiff(diffDiagrams(null, currentXml)) };
  }
  let previous = previousXml;
  try {
    previous = assertLoadableMxfile(previousXml);
  } catch {
    previous = previousXml;
  }
  return { previousXml: previous, diagramDiff: formatDiagramDiff(diffDiagrams(previous, currentXml)) };
}

function operationsOf(decision: KevDecision): DiagramOperation[] {
  if (decision.operations.length > 0) return decision.operations;
  if (decision.intent === "clarify" || decision.intent === "noop") return [];
  return [{ intent: decision.intent, slots: decision.slots }];
}

function isEdgeRestyle(operation: DiagramOperation): boolean {
  if (operation.intent !== "style" && operation.intent !== "edit_shape") return false;
  const query = operation.slots.target || operation.slots.label || "";
  return edgeQuery(query) !== null;
}

function structureKey(summary: DiagramSummary): string {
  const nodes = summary.vertices
    .map((vertex) => `${vertex.label}\t${Math.round(vertex.x)}\t${Math.round(vertex.y)}`)
    .sort();
  const edges = summary.edges.map((edge) => `${edge.from}\t${edge.to}\t${edge.label}`).sort();
  return `${nodes.join("\n")}\n--\n${edges.join("\n")}`;
}

function xmlSatisfies(beforeXml: string, afterXml: string, decision: KevDecision): boolean {
  let before;
  let after;
  try {
    before = summarizeDiagram(beforeXml);
    after = summarizeDiagram(afterXml);
  } catch {
    return false;
  }
  const operations = operationsOf(decision);
  const deletes = operations.filter((operation) => operation.intent === "delete_shape").length;
  if (after.vertices.length < before.vertices.length - deletes) return false;
  if (before.vertices.length > 0 && after.vertices.length === 0 && deletes < before.vertices.length) return false;
  if (decision.intent === "style" && structureKey(before) !== structureKey(after)) return false;
  const labels = after.vertices.map((vertex) => vertex.label.toLowerCase());
  for (const operation of operations) {
    if (operation.intent === "add_shape" && operation.slots.label) {
      const wanted = operation.slots.label.toLowerCase();
      if (!labels.some((label) => label.includes(wanted))) return false;
    }
    if (operation.intent === "edit_shape" && operation.slots.newLabel) {
      const wanted = operation.slots.newLabel.toLowerCase();
      if (!labels.some((label) => label.includes(wanted))) return false;
    }
  }
  return true;
}

function filled<T>(value: T | null | undefined, fallback: T | null | undefined): T | null {
  return value ?? fallback ?? null;
}

function mergeSlots(primary: DiagramSlots, fallback: DiagramSlots): DiagramSlots {
  return {
    label: filled(primary.label, fallback.label),
    shape: filled(primary.shape, fallback.shape),
    fillColor: filled(primary.fillColor, fallback.fillColor),
    strokeColor: filled(primary.strokeColor, fallback.strokeColor),
    colorName: filled(primary.colorName, fallback.colorName),
    from: filled(primary.from, fallback.from),
    to: filled(primary.to, fallback.to),
    target: filled(primary.target, fallback.target),
    newLabel: filled(primary.newLabel, fallback.newLabel),
    edgeLabel: filled(primary.edgeLabel, fallback.edgeLabel),
    layout: filled(primary.layout, fallback.layout),
    place: filled(primary.place, fallback.place),
    sequence: primary.sequence ?? fallback.sequence ?? null,
  };
}

/** "Add Test between Build and Deploy" names both ends. Place after/before must not append it. */
function betweenAddDecision(message: string): KevDecision | null {
  const demo = decideDemo(message);
  if (demo.intent !== "add_shape") return null;
  const slots = demo.operations[0]?.slots ?? demo.slots;
  if (!slots.from || !slots.to) return null;
  if (slots.place === "before" || slots.place === "after") return null;
  return demo;
}

function replyFromReading(reading: KevReading, slots: DiagramSlots): string {
  switch (reading.intent) {
    case "add_shape":
      return slots.label ? `Added ${slots.label}.` : "Added a shape.";
    case "edit_shape":
      return slots.newLabel ? `Renamed ${slots.target ?? "the shape"} to ${slots.newLabel}.` : `Updated ${slots.target ?? "the shape"}.`;
    case "delete_shape":
      return `Removed ${slots.target ?? "the shape"}.`;
    case "connect":
      return slots.from && slots.to ? `Connected ${slots.from} to ${slots.to}.` : "Added an edge.";
    case "layout":
      return slots.layout === "vertical"
        ? "Reflowed the diagram into a vertical column."
        : "Reflowed the diagram into a horizontal row.";
    case "style":
      return `Restyled ${slots.target ?? "the diagram"}${slots.colorName ? ` in ${slots.colorName}` : ""}.`;
    case "noop":
      return UNCHANGED_DIAGRAM_REPLY;
    default:
      return "What should I change on the diagram?";
  }
}

/** Kev owns the intent. Demo text fills labels Kev cannot emit. Kev's closed choices win when set. */
export function mergeKevWithDemo(reading: KevReading, demo: KevDecision): KevDecision {
  const slots = mergeSlots(reading.slots, demo.slots);
  const between = demo.intent === "add_shape" ? (demo.operations[0]?.slots ?? demo.slots) : null;
  if (between?.from && between.to && between.place !== "before" && between.place !== "after") {
    slots.from = between.from;
    slots.to = between.to;
    slots.label = between.label ?? slots.label;
    slots.place = null;
    slots.target = null;
  }
  const matched = demo.intent === reading.intent;
  const reply = matched && demo.reply.trim() ? demo.reply : replyFromReading(reading, slots);
  if (reading.intent === "clarify" || reading.intent === "noop") {
    return { intent: reading.intent, slots, operations: [], reply, updatedXml: null };
  }
  return {
    intent: reading.intent,
    slots,
    operations: [{ intent: reading.intent, slots }],
    reply,
    updatedXml: null,
  };
}

function declinedReply(reading: KevReading, demo: KevDecision): string {
  if (reading.intent === "noop") return UNCHANGED_DIAGRAM_REPLY;
  if (reading.intent === "clarify") return demo.reply.trim() || "What should I change on the diagram?";
  return "Name the shape and the change.";
}

function result(
  decision: KevDecision,
  mode: KevMode,
  model: string | undefined,
  updatedXml: string,
  repaired: boolean,
  extra: { intent?: Intent; fallback?: boolean; confidence?: number | null; steps?: KevStep[] } = {},
): KevTurnResult {
  const reply =
    decision.intent === "noop"
      ? softenUnchangedReply(decision.reply, true)
      : decision.reply.trim() || "Done.";
  const turn: KevTurnResult = {
    reply,
    updatedXml,
    mode,
    model,
    intent: extra.intent ?? decision.intent,
    slots: withPalette(decision.slots),
    repaired,
  };
  if (extra.fallback) turn.fallback = true;
  if (typeof extra.confidence === "number") turn.confidence = extra.confidence;
  if (extra.steps) turn.steps = extra.steps;
  return turn;
}

function finish(
  decision: KevDecision,
  mode: KevMode,
  model: string | undefined,
  originalXml: string,
  currentXml: string,
  extra: { fallback?: boolean; confidence?: number | null; userMessage?: string } = {},
): KevTurnResult {
  if (extra.userMessage) {
    const uttered = edgeRestyleDecision(extra.userMessage);
    if (uttered) decision = uttered;
    else {
      const between = betweenAddDecision(extra.userMessage);
      // A model mxfile that appends the stage is not the edit. The host splices the named edge.
      if (between) decision = between;
    }
  }
  decision = groundDecision(currentXml, decision);
  if (decision.intent === "clarify" || decision.intent === "noop") {
    return result(decision, mode, model, originalXml, false, extra);
  }

  const operations = operationsOf(decision);
  // Edge words are not vertices. Apply the mutator so a model mxfile cannot skip the stroke change or move nodes.
  const edgeRestyle = operations.some(isEdgeRestyle);
  let candidate: string | null = null;
  if (!edgeRestyle && decision.updatedXml && decision.updatedXml.length <= MAX_XML) {
    try {
      const normalized = assertLoadableMxfile(decision.updatedXml);
      if (xmlSatisfies(currentXml, normalized, decision)) candidate = normalized;
    } catch {
      candidate = null;
    }
  }

  if (candidate) return result(decision, mode, model, candidate, false, extra);

  if (operations.length === 0) {
    return result(
      {
        ...decision,
        reply: decision.reply.trim() || "I couldn't apply that change safely. Name the shapes you want to change.",
        intent: "clarify",
      },
      mode,
      model,
      originalXml,
      false,
      { ...extra, intent: "clarify" },
    );
  }

  try {
    const updated = applyOperations(currentXml, operations);
    if (sameMxfile(updated, currentXml) || sameMxfile(updated, originalXml)) {
      return result(
        { ...decision, intent: "noop", operations: [], reply: UNCHANGED_DIAGRAM_REPLY, updatedXml: null },
        mode,
        model,
        originalXml,
        false,
        { ...extra, intent: "noop" },
      );
    }
    return result(decision, mode, model, updated, Boolean(decision.updatedXml), extra);
  } catch (error) {
    if (error instanceof DiagramXmlError) {
      return result(
        { ...decision, reply: error.message, intent: "clarify", operations: [] },
        mode,
        model,
        originalXml,
        false,
        { ...extra, intent: "clarify" },
      );
    }
    throw error;
  }
}

function localDiagram(
  userMessage: string,
  currentXml: string,
  originalXml: string,
  mode: KevMode,
  model?: string,
): KevTurnResult | null {
  if (overNamedCapacity(userMessage)) {
    return result(
      { intent: "clarify", slots: {}, operations: [], reply: CAPACITY_REPLY, updatedXml: null },
      mode,
      model,
      originalXml,
      false,
    );
  }
  const composed = resolveComposition(userMessage);
  if (composed) {
    const placed = composeOnCanvas(userMessage, currentXml, composed, renderComposition(composed));
    if (placed === "unchanged" || (placed !== "keep" && sameMxfile(placed.xml, originalXml))) {
      return result(
        { intent: "noop", slots: {}, operations: [], reply: UNCHANGED_DIAGRAM_REPLY, updatedXml: null },
        mode,
        model,
        originalXml,
        false,
      );
    }
    if (placed === "keep") {
      return result(
        { intent: "noop", slots: {}, operations: [], reply: KEPT_CANVAS_REPLY, updatedXml: null },
        mode,
        model,
        originalXml,
        false,
      );
    }
    return result(placed.decision, mode, model, placed.xml, false);
  }
  const plan = resolvePlan(userMessage);
  if (!plan) return null;
  const operations = operationsForPlan(plan, currentXml);
  if (operations.length === 0) {
    return result(
      { intent: "noop", slots: {}, operations: [], reply: UNCHANGED_DIAGRAM_REPLY, updatedXml: null },
      mode,
      model,
      originalXml,
      false,
    );
  }
  const drawn = finish(architectureDecision(plan, operations), mode, model, originalXml, currentXml, {
    userMessage,
  });
  if (sameMxfile(drawn.updatedXml, originalXml) || sameMxfile(drawn.updatedXml, currentXml)) {
    return result(
      { intent: "noop", slots: {}, operations: [], reply: UNCHANGED_DIAGRAM_REPLY, updatedXml: null },
      mode,
      model,
      originalXml,
      false,
    );
  }
  return drawn;
}

async function runOpenAITurn(input: {
  request: {
    messages: ChatMessage[];
    currentXml: string;
    previousXml: string | null;
    diagramDiff: string;
  };
  userMessage: string;
  currentXml: string;
  originalXml: string;
  fallback?: boolean;
}): Promise<KevTurnResult> {
  const client = new OpenAIKevClient();
  let templateReference = templateReferenceFor(input.userMessage);
  let decision = await client.decide({ ...input.request, templateReference });
  if (
    decision.intent === "clarify" &&
    (isStateMachineRequest(input.userMessage) || resolveComposition(input.userMessage)?.grounded)
  ) {
    const composed = resolveComposition(input.userMessage);
    if (composed) {
      const placed = composeOnCanvas(input.userMessage, input.currentXml, composed, renderComposition(composed));
      if (placed !== "keep" && placed !== "unchanged") {
        return result(placed.decision, "openai", client.model, placed.xml, false, {
          fallback: input.fallback,
        });
      }
    }
  }
  if (decision.intent === "clarify" || decision.intent === "noop") {
    const topicContext = await topicContextFor(input.userMessage, true);
    const researched = topicContext ? composeFromBrief(input.userMessage, topicContext) : null;
    if (researched) {
      if (!researched.colorName) researched.colorName = colorInMessage(input.userMessage);
      const placed = composeOnCanvas(input.userMessage, input.currentXml, researched, renderComposition(researched));
      if (placed !== "keep" && placed !== "unchanged") {
        return result(placed.decision, "openai", client.model, placed.xml, false, {
          fallback: input.fallback,
        });
      }
    }
    if (topicContext) {
      templateReference = templateReferenceFor(input.userMessage, topicContext) ?? templateReference;
      decision = await client.decide({ ...input.request, topicContext, templateReference });
    }
  }
  return finish(decision, "openai", client.model, input.originalXml, input.currentXml, {
    fallback: input.fallback,
    userMessage: input.userMessage,
  });
}

export async function runKevTurn(input: {
  messages: ChatMessage[];
  currentXml: string;
  previousXml?: string | null;
}): Promise<KevTurnResult> {
  let currentXml: string;
  try {
    currentXml = assertLoadableMxfile(input.currentXml);
  } catch (error) {
    const message = error instanceof DiagramXmlError ? error.message : "The current diagram XML could not be read.";
    throw new KevError(message, 400);
  }

  const described = describeMode();
  const userMessage = latestUser(input.messages);
  const utteredEdges = edgeRestyleDecision(userMessage);
  if (utteredEdges) {
    return finish(utteredEdges, described.mode, described.model, input.currentXml, currentXml, { userMessage });
  }
  const betweenAdd = betweenAddDecision(userMessage);
  if (betweenAdd) {
    return finish(betweenAdd, described.mode, described.model, input.currentXml, currentXml, { userMessage });
  }
  const context = editContext(currentXml, input.previousXml);
  const request = {
    messages: input.messages,
    currentXml,
    previousXml: context.previousXml,
    diagramDiff: context.diagramDiff,
  };

  if (described.mode === "demo") {
    const local = localDiagram(userMessage, currentXml, input.currentXml, "demo");
    if (local) return local;
    return finish(decideDemo(userMessage), "demo", undefined, input.currentXml, currentXml);
  }

  if (described.mode === "openai") {
    return runOpenAITurn({
      request,
      userMessage,
      currentXml,
      originalXml: input.currentXml,
    });
  }

  const templateReference = templateReferenceFor(userMessage);
  let reading: KevReading;
  try {
    reading = await askKev({
      userMessage,
      currentXml,
      previousXml: context.previousXml,
      diagramDiff: context.diagramDiff,
      templateReference,
    });
  } catch (error) {
    if (error instanceof KevUnreachableError) {
      const drawn = localDiagram(userMessage, currentXml, input.currentXml, "kev", described.model);
      if (drawn) return drawn;
      if (described.openai) {
        return runOpenAITurn({
          request,
          userMessage,
          currentXml,
          originalXml: input.currentXml,
          fallback: true,
        });
      }
    }
    throw error;
  }

  const model = reading.model ?? described.model;
  const demo = decideDemo(userMessage);

  try {
    const orchestrated = await maybeOrchestrate({
      userMessage,
      currentXml,
      originalXml: input.currentXml,
      previousXml: context.previousXml,
      diagramDiff: context.diagramDiff,
      topicContext: null,
      reading,
      model,
    });
    if (orchestrated) return orchestrated;
  } catch (error) {
    if (error instanceof KevUnreachableError) {
      const drawn = localDiagram(userMessage, currentXml, input.currentXml, "kev", model);
      if (drawn) return drawn;
      if (described.openai) {
        return runOpenAITurn({
          request,
          userMessage,
          currentXml,
          originalXml: input.currentXml,
          fallback: true,
        });
      }
    }
    throw error;
  }

  if (!reading.needsXmlEdit) {
    const intent: Intent = reading.intent === "noop" ? "noop" : "clarify";
    return result(
      {
        intent,
        slots: mergeSlots(reading.slots, demo.slots),
        operations: [],
        reply: declinedReply(reading, demo),
        updatedXml: null,
      },
      "kev",
      model,
      input.currentXml,
      false,
      { confidence: reading.confidence },
    );
  }

  if (described.openai) {
    try {
      const written = await writeDiagramXml({
        messages: input.messages,
        currentXml,
        previousXml: context.previousXml,
        diagramDiff: context.diagramDiff,
        topicContext: null,
        templateReference,
        reading,
      });
      const slots = mergeSlots(written.slots, reading.slots);
      const operations =
        written.operations.length > 0
          ? written.operations
          : isMutatingIntent(reading.intent)
            ? [{ intent: reading.intent, slots }]
            : [];
      return finish(
        {
          intent: reading.intent,
          slots,
          operations,
          reply: written.reply.trim() || replyFromReading(reading, slots),
          updatedXml: written.updatedXml,
        },
        "kev",
        model,
        input.currentXml,
        currentXml,
        { confidence: reading.confidence, userMessage },
      );
    } catch (error) {
      if (!(error instanceof KevError)) throw error;
    }
  }

  return finish(mergeKevWithDemo(reading, demo), "kev", model, input.currentXml, currentXml, {
    confidence: reading.confidence,
    userMessage,
  });
}
