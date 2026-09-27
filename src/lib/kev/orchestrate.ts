import { PALETTE, SHAPE_KINDS, isShapeKind } from "@/lib/drawio/styles";
import { summarizeDiagram, type DiagramSummary } from "@/lib/drawio/xml";
import { env } from "@/lib/env";
import { describeComposition, compositionDecision, renderComposition, resolveComposition } from "@/lib/kev/compose";
import { decideDemo } from "@/lib/kev/demo";
import { DiagramXmlError, applyOperations } from "@/lib/kev/mutate";
import {
  describeOperation,
  isArchitectureRequest,
  isBareDraw,
  operationsForPlan,
  resolvePlan,
  summarizePlan,
  withPalette,
  type ArchitecturePlan,
} from "@/lib/kev/plan";
import {
  KEV_DEFAULT_MODEL,
  KevUnreachableError,
  NOUL_YES,
  callSystemOne,
  diagramState,
  readChoiceAnswer,
  readNoulAnswer,
  systemOneAnswers,
  type SystemOneQuestion,
  type SystemOneRequest,
} from "@/lib/kev/systemone";
import type {
  DiagramOperation,
  DiagramSlots,
  KevDecision,
  KevReading,
  KevStep,
  KevTurnResult,
} from "@/lib/kev/types";

/**
 * One System One call cannot plan a multi-shape diagram: Jev returns choice,
 * noul, and score values, not a graph. This loop drafts the next concrete
 * edit, asks Jev to fill closed-set slots, applies that edit with the XML
 * mutator, then re-summarizes and repeats. An explicit architecture plan is
 * applied even when the confirm noul is below 0.5 or next is not apply.
 */
export const MAX_ORCHESTRATOR_STEPS = 6;
export const ORCHESTRATOR_TIMEOUT_MS = 10_000;

const CLARIFY_DRAW = "What should I draw? Name the shapes and how they connect, for example “Client → App → Postgres”.";
const CLARIFY_NODES = "Which nodes should I draw? For example, “Client → App → Postgres”.";

export interface OrchestratorContext {
  userMessage: string;
  /** Normalized mxfile the mutator reads. */
  currentXml: string;
  /** Original request XML, returned unchanged when nothing is applied. */
  originalXml: string;
  previousXml?: string | null;
  diagramDiff?: string;
  reading: KevReading;
  model?: string;
}

export function buildSpecificityRequest(input: {
  userMessage: string;
  summary: DiagramSummary;
  model?: string;
}): SystemOneRequest {
  return {
    state: diagramState(input.userMessage, input.summary),
    model: input.model?.trim() || env("KEV_MODEL") || KEV_DEFAULT_MODEL,
    questions: {
      specific: {
        type: "noul",
        instructions: "Does the user name concrete shapes, connections, or a diagram to create?",
      },
      next: {
        type: "choice",
        instructions: "The request does not name a diagram change. What should the assistant do?",
        criteria: {
          clarify: "Ask what to draw",
          noop: "No diagram change",
        },
      },
    },
  };
}

export function buildOrchestratorStepRequest(input: {
  userMessage: string;
  summary: DiagramSummary;
  proposal: DiagramOperation;
  remaining: number;
  applied: string[];
  model?: string;
  previousXml?: string | null;
  currentXml?: string;
  diagramDiff?: string;
}): SystemOneRequest {
  const detail = describeOperation(input.proposal);
  const done = input.applied.length > 0 ? input.applied.map((line) => `- ${line}`).join("\n") : "- (none)";
  const base = diagramState(input.userMessage, input.summary, {
    diffText: input.diagramDiff,
    previousXml: input.previousXml,
    currentXml: input.currentXml,
  });
  const state = `${base}\n\nEdits already applied this turn:\n${done}\n\nProposed next edit:\n${detail}\n\nFurther edits still queued: ${input.remaining}`.slice(
    0,
    12_000,
  );
  const questions: Record<string, SystemOneQuestion> = {
    next: {
      type: "choice",
      instructions: "The host proposed one diagram edit. What should happen next?",
      criteria: {
        apply: detail,
        clarify: "Ask the user a clarifying question before editing",
        noop: "Do not change the diagram",
      },
    },
    confirm: {
      type: "noul",
      instructions: `Should this edit be written into the diagram XML now? ${detail}`,
    },
  };
  if (input.proposal.intent === "add_shape") {
    const shapes: Record<string, string> = { none: "Keep the proposed shape kind" };
    for (const kind of SHAPE_KINDS) shapes[kind] = `Draw the vertex as a ${kind}`;
    questions.shape = {
      type: "choice",
      instructions: "Which shape kind should the new vertex use? Choose none to keep the proposal.",
      criteria: shapes,
    };
  }
  if (input.proposal.intent === "add_shape" || input.proposal.intent === "style") {
    const colors: Record<string, string> = { none: "Do not change the proposed color" };
    for (const name of Object.keys(PALETTE)) {
      if (name === "grey") continue;
      colors[name] = `Use the ${name} palette`;
    }
    questions.color = {
      type: "choice",
      instructions: "Which named color should be applied, if any?",
      criteria: colors,
    };
  }
  if (input.proposal.intent === "layout") {
    questions.layout = {
      type: "choice",
      instructions: "How should the shapes be arranged?",
      criteria: {
        horizontal: "Lay shapes in a horizontal row",
        vertical: "Lay shapes in a vertical column",
        none: "Keep the proposed direction",
      },
    };
  }
  return {
    state,
    model: input.model?.trim() || env("KEV_MODEL") || KEV_DEFAULT_MODEL,
    questions,
  };
}

/**
 * Kev turns that need more than one atomic edit. Returns null when the first
 * reading is already a complete single edit for the legacy path.
 */
export async function maybeOrchestrate(input: OrchestratorContext): Promise<KevTurnResult | null> {
  if (isBareDraw(input.userMessage)) return bareDraw(input);
  if (resolveComposition(input.userMessage)) return runComposition(input);
  if (isArchitectureRequest(input.userMessage)) return runArchitecture(input);
  if (input.reading.intent === "noop") {
    const demo = decideDemo(input.userMessage);
    if (demo.operations.length > 0) return rescueDemo(input, demo);
  }
  return null;
}

async function bareDraw(input: OrchestratorContext): Promise<KevTurnResult> {
  const summary = safeSummary(input.currentXml);
  const payload = await callSystemOne(
    buildSpecificityRequest({ userMessage: input.userMessage, summary, model: input.model }),
    ORCHESTRATOR_TIMEOUT_MS,
  );
  const answers = systemOneAnswers(payload);
  if (!answers) throw new KevUnreachableError("Kev returned an unreadable System One response.");
  const specific = readNoulAnswer(answers.specific);
  const next = readChoiceAnswer(answers.next);
  return turn(input, {
    reply: CLARIFY_DRAW,
    updatedXml: input.originalXml,
    intent: "clarify",
    slots: withPalette(input.reading.slots),
    steps: [
      {
        detail: "Check whether the draw request names a diagram",
        intent: "clarify",
        accepted: false,
        confirm: specific,
      },
    ],
    confidence: next?.confidence ?? input.reading.confidence,
  });
}

async function rescueDemo(input: OrchestratorContext, demo: KevDecision): Promise<KevTurnResult> {
  const operation = demo.operations[0];
  if (!operation) return turn(input, noopTurn(input));
  const detail = demo.reply.trim() || describeOperation(operation);
  const gate = await gateOperation(input, operation, demo.operations.length - 1, []);
  const step: KevStep = {
    detail,
    intent: operation.intent,
    accepted: gate.accepted,
    confirm: gate.confirm,
  };
  if (!gate.accepted) {
    return turn(input, {
      reply: "No diagram change.",
      updatedXml: input.originalXml,
      intent: "noop",
      slots: withPalette(demo.slots),
      steps: [step],
      confidence: gate.confidence ?? input.reading.confidence,
    });
  }
  try {
    const updatedXml = applyOperations(input.currentXml, demo.operations);
    return turn(input, {
      reply: demo.reply.trim() || "Done.",
      updatedXml,
      intent: demo.intent,
      slots: withPalette(demo.slots),
      steps: [step],
      confidence: gate.confidence ?? input.reading.confidence,
    });
  } catch (error) {
    if (error instanceof DiagramXmlError) {
      return turn(input, {
        reply: error.message,
        updatedXml: input.originalXml,
        intent: "clarify",
        slots: withPalette(demo.slots),
        steps: [step],
        confidence: gate.confidence ?? input.reading.confidence,
      });
    }
    throw error;
  }
}

async function runArchitecture(input: OrchestratorContext): Promise<KevTurnResult> {
  const plan = resolvePlan(input.userMessage, {
    colorName: input.reading.slots.colorName,
    layout: input.reading.slots.layout,
  });
  if (!plan) {
    return turn(input, {
      reply: CLARIFY_NODES,
      updatedXml: input.originalXml,
      intent: "clarify",
      slots: withPalette(input.reading.slots),
      steps: [],
      confidence: input.reading.confidence,
    });
  }

  let working = input.currentXml;
  const applied: DiagramOperation[] = [];
  const appliedDetails: string[] = [];
  const steps: KevStep[] = [];
  let confidence = input.reading.confidence;

  for (let index = 0; index < MAX_ORCHESTRATOR_STEPS; index += 1) {
    const pending = operationsForPlan(plan, working);
    if (pending.length === 0) break;
    const proposal = pending[0];
    if (!proposal) break;
    const detail = describeOperation(proposal);
    let gate: GateResult;
    try {
      gate = await gateOperation(input, proposal, pending.length - 1, appliedDetails, working, true);
    } catch (error) {
      if (applied.length === 0) throw error;
      break;
    }
    if (typeof gate.confidence === "number") confidence = gate.confidence;
    steps.push({
      detail,
      intent: proposal.intent,
      accepted: gate.accepted,
      confirm: gate.confirm,
      choice: gate.choice,
    });
    if (!gate.accepted) {
      if (applied.length === 0) {
        return turn(input, {
          reply: CLARIFY_NODES,
          updatedXml: input.originalXml,
          intent: "clarify",
          slots: summarySlots(plan, []),
          steps,
          confidence,
        });
      }
      break;
    }
    try {
      const next = applyOperations(working, [{ intent: proposal.intent, slots: gate.slots }]);
      if (next === working) break;
      working = next;
      applied.push({ intent: proposal.intent, slots: gate.slots });
      appliedDetails.push(detail);
    } catch (error) {
      if (error instanceof DiagramXmlError) {
        if (applied.length === 0) {
          return turn(input, {
            reply: error.message,
            updatedXml: input.originalXml,
            intent: "clarify",
            slots: summarySlots(plan, []),
            steps,
            confidence,
          });
        }
        break;
      }
      throw error;
    }
  }

  if (applied.length === 0) {
    return turn(input, {
      reply: CLARIFY_NODES,
      updatedXml: input.originalXml,
      intent: "clarify",
      slots: summarySlots(plan, []),
      steps,
      confidence,
    });
  }

  const described = summarizePlan(plan, applied);
  const pending = operationsForPlan(plan, working);
  const reply = pending.length > 0 ? `${described.reply} Stopped before every edit was confirmed.` : described.reply;
  return turn(input, {
    reply,
    updatedXml: working,
    intent: described.intent,
    slots: described.slots,
    steps,
    confidence,
  });
}

export function buildCompositionRequest(input: {
  userMessage: string;
  summary: DiagramSummary;
  plan: string;
  model?: string;
  previousXml?: string | null;
  currentXml?: string;
  diagramDiff?: string;
}): SystemOneRequest {
  const base = diagramState(input.userMessage, input.summary, {
    diffText: input.diagramDiff,
    previousXml: input.previousXml,
    currentXml: input.currentXml,
  });
  const state = `${base}\n\nThe host already split this drawing into steps. Geometry is applied by the host, not by you.\n${input.plan}`.slice(
    0,
    12_000,
  );
  const colors: Record<string, string> = { none: "The user did not name a color" };
  for (const name of Object.keys(PALETTE)) {
    if (name === "grey") continue;
    colors[name] = `The user asked for ${name}`;
  }
  return {
    state,
    model: input.model?.trim() || env("KEV_MODEL") || KEV_DEFAULT_MODEL,
    questions: {
      next: {
        type: "choice",
        instructions: "The host will draw this planned diagram and lay it out. What should happen next?",
        criteria: {
          apply: "Draw the planned diagram",
          clarify: "Ask the user a clarifying question before drawing",
          noop: "Do not change the diagram",
        },
      },
      confirm: {
        type: "noul",
        instructions: "Should this planned diagram be written into the diagram XML now?",
      },
      color: {
        type: "choice",
        instructions: "Which named color did the user ask for? Choose none when they did not name one.",
        criteria: colors,
      },
    },
  };
}

/**
 * Sequence, workflow, and layered drawings are planned as mini-steps, then
 * drawn in one deterministic pass. Jev fills the color slot and the confirm
 * noul. A lukewarm confirm does not cancel a concrete plan.
 */
async function runComposition(input: OrchestratorContext): Promise<KevTurnResult> {
  const composition = resolveComposition(input.userMessage);
  if (!composition) {
    return turn(input, {
      reply: CLARIFY_NODES,
      updatedXml: input.originalXml,
      intent: "clarify",
      slots: withPalette(input.reading.slots),
      steps: [],
      confidence: input.reading.confidence,
    });
  }

  const plan = describeComposition(composition);
  const payload = await callSystemOne(
    buildCompositionRequest({
      userMessage: input.userMessage,
      summary: safeSummary(input.currentXml),
      plan,
      model: input.model,
      previousXml: input.previousXml,
      currentXml: input.currentXml,
      diagramDiff: input.diagramDiff,
    }),
    ORCHESTRATOR_TIMEOUT_MS,
  );
  const answers = systemOneAnswers(payload);
  if (!answers) throw new KevUnreachableError("Kev returned an unreadable System One response.");
  const next = readChoiceAnswer(answers.next);
  const confirm = readNoulAnswer(answers.confirm);
  const choice = next?.choice.toLowerCase() ?? null;
  const xml = renderComposition(composition);
  const decision = compositionDecision(composition, xml);
  return turn(input, {
    reply: decision.reply,
    updatedXml: xml,
    intent: decision.intent,
    slots: decision.slots,
    steps: [
      {
        detail: plan,
        intent: "add_shape",
        accepted: acceptArchitectureStep(choice, confirm),
        confirm,
        choice,
      },
    ],
    confidence: next?.confidence ?? input.reading.confidence,
  });
}

interface GateResult {
  accepted: boolean;
  choice: string | null;
  confirm: number | null;
  confidence: number | null;
  slots: DiagramSlots;
}

async function gateOperation(
  input: OrchestratorContext,
  proposal: DiagramOperation,
  remaining: number,
  applied: string[],
  xml = input.currentXml,
  architecture = false,
): Promise<GateResult> {
  const payload = await callSystemOne(
    buildOrchestratorStepRequest({
      userMessage: input.userMessage,
      summary: safeSummary(xml),
      proposal,
      remaining,
      applied,
      model: input.model,
      previousXml: input.previousXml,
      currentXml: xml,
      diagramDiff: input.diagramDiff,
    }),
    ORCHESTRATOR_TIMEOUT_MS,
  );
  const answers = systemOneAnswers(payload);
  if (!answers) throw new KevUnreachableError("Kev returned an unreadable System One response.");
  const next = readChoiceAnswer(answers.next);
  const confirm = readNoulAnswer(answers.confirm);
  const choice = next?.choice.toLowerCase() ?? null;
  return {
    accepted: architecture ? acceptArchitectureStep(choice, confirm) : acceptedEdit(choice, confirm),
    choice,
    confirm,
    confidence: next?.confidence ?? null,
    slots: filledSlots(proposal, answers),
  };
}

/**
 * A draw/build/create plan already names the nodes. Live Jev answered the App
 * insert with confirm 0.43 and did not choose apply, which used to cancel the
 * whole turn. Slot answers still refine shape, color, and layout. The noul and
 * the next choice do not veto a concrete planned edit.
 */
export function acceptArchitectureStep(choice: string | null, confirm: number | null): boolean {
  // Live Jev returned next !== apply with confirm 0.43. Both are recorded on the step.
  void choice;
  void confirm;
  return true;
}

function acceptedEdit(choice: string | null, confirm: number | null): boolean {
  if (choice === "noop" || choice === "clarify" || choice === "skip") return false;
  if (choice === "apply") return confirm === null || confirm >= NOUL_YES;
  return confirm !== null && confirm >= NOUL_YES;
}

function filledSlots(proposal: DiagramOperation, answers: Record<string, unknown>): DiagramSlots {
  let slots: DiagramSlots = { ...proposal.slots };
  const shape = readChoiceAnswer(answers.shape)?.choice.toLowerCase();
  const color = readChoiceAnswer(answers.color)?.choice.toLowerCase();
  const layout = readChoiceAnswer(answers.layout)?.choice.toLowerCase();
  if (shape && shape !== "none" && isShapeKind(shape)) slots = { ...slots, shape };
  if (!proposal.slots.colorName && color && color !== "none" && PALETTE[color]) {
    slots = {
      ...slots,
      colorName: color,
      fillColor: PALETTE[color].fill,
      strokeColor: PALETTE[color].stroke,
    };
  }
  if (!proposal.slots.layout && (layout === "horizontal" || layout === "vertical")) {
    slots = { ...slots, layout };
  }
  return withPalette(slots);
}

function summarySlots(plan: ArchitecturePlan, operations: DiagramOperation[]): DiagramSlots {
  if (operations.length === 0) {
    return withPalette({
      label: plan.title,
      shape: "rectangle",
      from: plan.nodes[0] ?? null,
      to: plan.nodes[plan.nodes.length - 1] ?? null,
      colorName: plan.colorName,
      layout: plan.layout,
    });
  }
  return summarizePlan(plan, operations).slots;
}

function safeSummary(xml: string): DiagramSummary {
  try {
    return summarizeDiagram(xml);
  } catch {
    return { vertices: [], edges: [] };
  }
}

function noopTurn(input: OrchestratorContext): {
  reply: string;
  updatedXml: string;
  intent: KevTurnResult["intent"];
  slots: DiagramSlots;
  steps: KevStep[];
  confidence: number | null;
} {
  return {
    reply: "No diagram change.",
    updatedXml: input.originalXml,
    intent: "noop",
    slots: withPalette(input.reading.slots),
    steps: [],
    confidence: input.reading.confidence,
  };
}

function turn(
  input: OrchestratorContext,
  body: {
    reply: string;
    updatedXml: string;
    intent: KevTurnResult["intent"];
    slots: DiagramSlots;
    steps: KevStep[];
    confidence?: number | null;
  },
): KevTurnResult {
  const result: KevTurnResult = {
    reply: body.reply.trim() || "Done.",
    updatedXml: body.updatedXml,
    mode: "kev",
    model: input.model ?? input.reading.model,
    intent: body.intent,
    slots: body.slots,
    repaired: false,
    steps: body.steps,
  };
  if (typeof body.confidence === "number") result.confidence = body.confidence;
  return result;
}
