import { diffDiagrams, formatDiagramDiff } from "@/lib/drawio/diff";
import { assertLoadableMxfile, summarizeDiagram } from "@/lib/drawio/xml";
import { env } from "@/lib/env";
import { KevError } from "@/lib/kev/client";
import { compositionDecision, renderComposition, resolveComposition } from "@/lib/kev/compose";
import { decideDemo } from "@/lib/kev/demo";
import { DiagramXmlError, applyOperations } from "@/lib/kev/mutate";
import { OPENAI_DEFAULT_MODEL, OpenAIKevClient, writeDiagramXml } from "@/lib/kev/openai";
import { maybeOrchestrate } from "@/lib/kev/orchestrate";
import { architectureDecision, isArchitectureRequest, isBareDraw, operationsForPlan, resolvePlan, withPalette } from "@/lib/kev/plan";
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
      return "No diagram change.";
    default:
      return "What should I change on the diagram?";
  }
}

/** Kev owns the intent. Demo text fills labels Kev cannot emit. Kev's closed choices win when set. */
export function mergeKevWithDemo(reading: KevReading, demo: KevDecision): KevDecision {
  const slots = mergeSlots(reading.slots, demo.slots);
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
  if (reading.intent === "noop") return "No diagram change.";
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
  const turn: KevTurnResult = {
    reply: decision.reply.trim() || "Done.",
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
  extra: { fallback?: boolean; confidence?: number | null } = {},
): KevTurnResult {
  if (decision.intent === "clarify" || decision.intent === "noop") {
    return result(decision, mode, model, originalXml, false, extra);
  }

  const operations = operationsOf(decision);
  let candidate: string | null = null;
  if (decision.updatedXml && decision.updatedXml.length <= MAX_XML) {
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
  const composed = resolveComposition(userMessage);
  if (composed) {
    const xml = renderComposition(composed);
    return result(compositionDecision(composed, xml), mode, model, xml, false);
  }
  const plan = resolvePlan(userMessage);
  if (!plan) return null;
  const operations = operationsForPlan(plan, currentXml);
  if (operations.length === 0) return null;
  return finish(architectureDecision(plan, operations), mode, model, originalXml, currentXml);
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
  const context = editContext(currentXml, input.previousXml);
  const request = {
    messages: input.messages,
    currentXml,
    previousXml: context.previousXml,
    diagramDiff: context.diagramDiff,
  };

  if (described.mode === "demo" || described.mode === "openai") {
    const local = localDiagram(userMessage, currentXml, input.currentXml, described.mode, described.model);
    if (local) return local;
    if (described.mode === "demo") {
      return finish(decideDemo(userMessage), "demo", undefined, input.currentXml, currentXml);
    }
    const client = new OpenAIKevClient();
    const decision = await client.decide(request);
    return finish(decision, "openai", client.model, input.currentXml, currentXml);
  }

  let reading: KevReading;
  const loopTimeout =
    isArchitectureRequest(userMessage) || isBareDraw(userMessage) || resolveComposition(userMessage) !== null;
  try {
    reading = await askKev(
      {
        userMessage,
        currentXml,
        previousXml: context.previousXml,
        diagramDiff: context.diagramDiff,
      },
      loopTimeout ? { timeoutMs: 10_000 } : undefined,
    );
  } catch (error) {
    if (error instanceof KevUnreachableError) {
      const drawn = localDiagram(userMessage, currentXml, input.currentXml, "kev", described.model);
      if (drawn) return drawn;
      if (described.openai) {
        const client = new OpenAIKevClient();
        const decision = await client.decide(request);
        return finish(decision, "openai", client.model, input.currentXml, currentXml, { fallback: true });
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
      reading,
      model,
    });
    if (orchestrated) return orchestrated;
  } catch (error) {
    if (error instanceof KevUnreachableError) {
      const drawn = localDiagram(userMessage, currentXml, input.currentXml, "kev", model);
      if (drawn) return drawn;
      if (described.openai) {
        const client = new OpenAIKevClient();
        const decision = await client.decide(request);
        return finish(decision, "openai", client.model, input.currentXml, currentXml, { fallback: true });
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
        { confidence: reading.confidence },
      );
    } catch (error) {
      if (!(error instanceof KevError)) throw error;
    }
  }

  return finish(mergeKevWithDemo(reading, demo), "kev", model, input.currentXml, currentXml, {
    confidence: reading.confidence,
  });
}
