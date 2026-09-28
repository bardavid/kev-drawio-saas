import { PALETTE, SHAPE_KINDS, isShapeKind } from "@/lib/drawio/styles";
import { summarizeDiagram, type DiagramSummary } from "@/lib/drawio/xml";
import { env } from "@/lib/env";
import {
  colorInMessage,
  describeComposition,
  compositionDecision,
  renderComposition,
  resolveComposition,
  sameMxfile,
  templateCanvasPlan,
  type Composition,
} from "@/lib/kev/compose";
import { composeFromBrief, isStateMachineRequest } from "@/lib/kev/templates";
import { KEPT_CANVAS_REPLY, UNCHANGED_DIAGRAM_REPLY, softenUnchangedReply } from "@/lib/kev/reply";
import { researchTopic, wikipediaTitle } from "@/lib/kev/research";
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
  COLOR_KEEP,
  COLOR_NONE,
  COMPOSITION_CLARIFY,
  COMPOSITION_COLOR_INSTRUCTIONS,
  COMPOSITION_NOOP,
  COMPOSITION_REFERENCE_LEAD,
  SHAPE_KEEP,
  SPECIFICITY_NEXT_CRITERIA,
  SPECIFICITY_NEXT_INSTRUCTIONS,
  SPECIFIC_INSTRUCTIONS,
  STEP_CLARIFY,
  STEP_COLOR_INSTRUCTIONS,
  STEP_LAYOUT_CRITERIA,
  STEP_LAYOUT_INSTRUCTIONS,
  STEP_NEXT_INSTRUCTIONS,
  STEP_NOOP,
  STEP_SHAPE_INSTRUCTIONS,
  colorCriterion,
  compositionApplyCriterion,
  compositionConfirmInstructions,
  compositionNextInstructions,
  shapeKindCriterion,
  stepApplyCriterion,
  stepConfirmInstructions,
} from "@/lib/kev/prompt-guide";
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

/** Unsure readings are the only reason to look up external topic notes. */
export function modelIsUnsure(reading: { intent: string; needsXmlEdit: boolean }): boolean {
  return reading.intent === "clarify" || reading.intent === "noop" || !reading.needsXmlEdit;
}

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
  /** Factual notes fetched before planning. Builtin text when the lookup is offline. */
  topicContext?: string | null;
  reading: KevReading;
  model?: string;
}

export function buildSpecificityRequest(input: {
  userMessage: string;
  summary: DiagramSummary;
  model?: string;
  currentXml?: string;
  previousXml?: string | null;
  diagramDiff?: string;
  topicContext?: string | null;
}): SystemOneRequest {
  return {
    state: diagramState(input.userMessage, input.summary, {
      diffText: input.diagramDiff,
      previousXml: input.previousXml,
      currentXml: input.currentXml,
      topicContext: input.topicContext,
    }),
    model: input.model?.trim() || env("KEV_MODEL") || KEV_DEFAULT_MODEL,
    questions: {
      specific: {
        type: "noul",
        instructions: SPECIFIC_INSTRUCTIONS,
      },
      next: {
        type: "choice",
        instructions: SPECIFICITY_NEXT_INSTRUCTIONS,
        criteria: { ...SPECIFICITY_NEXT_CRITERIA },
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
      instructions: STEP_NEXT_INSTRUCTIONS,
      criteria: {
        apply: stepApplyCriterion(detail),
        clarify: STEP_CLARIFY,
        noop: STEP_NOOP,
      },
    },
    confirm: {
      type: "noul",
      instructions: stepConfirmInstructions(detail),
    },
  };
  if (input.proposal.intent === "add_shape") {
    const shapes: Record<string, string> = { none: SHAPE_KEEP };
    for (const kind of SHAPE_KINDS) shapes[kind] = shapeKindCriterion(kind);
    questions.shape = {
      type: "choice",
      instructions: STEP_SHAPE_INSTRUCTIONS,
      criteria: shapes,
    };
  }
  if (input.proposal.intent === "add_shape" || input.proposal.intent === "style") {
    const colors: Record<string, string> = { none: COLOR_KEEP };
    for (const name of Object.keys(PALETTE)) {
      if (name === "grey") continue;
      colors[name] = colorCriterion(name);
    }
    questions.color = {
      type: "choice",
      instructions: STEP_COLOR_INSTRUCTIONS,
      criteria: colors,
    };
  }
  if (input.proposal.intent === "layout") {
    questions.layout = {
      type: "choice",
      instructions: STEP_LAYOUT_INSTRUCTIONS,
      criteria: { ...STEP_LAYOUT_CRITERIA },
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

  let current = input;
  if (modelIsUnsure(input.reading) && wikipediaTitle(input.userMessage) && !input.topicContext) {
    const brief = await researchTopic(input.userMessage, { network: true });
    if (brief?.summary) current = { ...input, topicContext: brief.summary };
  }

  if (drawingFor(current)) return runComposition(current);
  if (isArchitectureRequest(input.userMessage)) return runArchitecture(current);
  if (current.reading.intent === "clarify" || current.reading.intent === "layout") {
    const addition = decideDemo(current.userMessage);
    if (addition.intent === "add_shape" && addition.slots.label) return applyHostAddition(current, addition);
  }
  if (current.reading.intent === "noop") {
    const demo = decideDemo(current.userMessage);
    if (demo.operations.length > 0) return rescueDemo(current, demo);
  }
  return null;
}

function applyHostAddition(input: OrchestratorContext, demo: KevDecision): KevTurnResult {
  try {
    const updatedXml = applyOperations(input.currentXml, demo.operations);
    return turn(input, {
      reply: demo.reply.trim() || "Done.",
      updatedXml,
      intent: demo.intent,
      slots: withPalette(demo.slots),
      steps: [
        {
          detail: demo.reply.trim() || "Add the named shape",
          intent: demo.intent,
          accepted: true,
          confirm: input.reading.confidence,
        },
      ],
      confidence: input.reading.confidence,
    });
  } catch (error) {
    if (error instanceof DiagramXmlError) {
      return turn(input, {
        reply: error.message,
        updatedXml: input.originalXml,
        intent: "clarify",
        slots: withPalette(demo.slots),
        steps: [],
        confidence: input.reading.confidence,
      });
    }
    throw error;
  }
}

async function bareDraw(input: OrchestratorContext): Promise<KevTurnResult> {
  const summary = safeSummary(input.currentXml);
  const payload = await callSystemOne(
    buildSpecificityRequest({
      userMessage: input.userMessage,
      summary,
      model: input.model,
      currentXml: input.currentXml,
      previousXml: input.previousXml,
      diagramDiff: input.diagramDiff,
      topicContext: input.topicContext,
    }),
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
      reply: UNCHANGED_DIAGRAM_REPLY,
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
  // Direction comes from the user's words, otherwise architecture runs left to right.
  // Live Jev reads "3 tier" as a column. That hint must not stack the chain.
  // "Vertically" still stacks it. The open canvas is edited, not replaced.
  const plan = resolvePlan(input.userMessage, {
    colorName: input.reading.slots.colorName,
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
  if (operationsForPlan(plan, working).length === 0) {
    return turn(input, {
      reply: UNCHANGED_DIAGRAM_REPLY,
      updatedXml: input.originalXml,
      intent: "noop",
      slots: summarySlots(plan, []),
      steps: [],
      confidence: input.reading.confidence,
    });
  }
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

export type CompositionPhase = "outline" | "structure" | "style";

export function buildCompositionRequest(input: {
  userMessage: string;
  summary: DiagramSummary;
  plan: string;
  model?: string;
  previousXml?: string | null;
  currentXml?: string;
  diagramDiff?: string;
  topicContext?: string | null;
  phase?: CompositionPhase;
}): SystemOneRequest {
  const base = diagramState(input.userMessage, input.summary, {
    diffText: input.diagramDiff,
    previousXml: input.previousXml,
    currentXml: input.currentXml,
    topicContext: input.topicContext,
  });
  const state = `${base}\n\n${COMPOSITION_REFERENCE_LEAD}\n${input.plan}`.slice(0, 12_000);
  const phase = input.phase ?? "style";
  const colors: Record<string, string> = { none: COLOR_NONE };
  for (const name of Object.keys(PALETTE)) {
    if (name === "grey") continue;
    colors[name] = colorCriterion(name);
  }
  const questions: Record<string, SystemOneQuestion> = {
    next: {
      type: "choice",
      instructions: compositionNextInstructions(phase),
      criteria: {
        apply: compositionApplyCriterion(phase),
        clarify: COMPOSITION_CLARIFY,
        noop: COMPOSITION_NOOP,
      },
    },
    confirm: {
      type: "noul",
      instructions: compositionConfirmInstructions(phase),
    },
  };
  if (phase === "style") {
    questions.color = {
      type: "choice",
      instructions: COMPOSITION_COLOR_INSTRUCTIONS,
      criteria: colors,
    };
  }
  return {
    state,
    model: input.model?.trim() || env("KEV_MODEL") || KEV_DEFAULT_MODEL,
    questions,
  };
}

const COMPOSITION_PHASES: Array<{ phase: CompositionPhase; detail: string }> = [
  { phase: "outline", detail: "Confirm the node outline" },
  { phase: "structure", detail: "Confirm the edges" },
  { phase: "style", detail: "Confirm the diagram style" },
];

function drawingFor(input: OrchestratorContext): Composition | null {
  const composition =
    resolveComposition(input.userMessage, { context: input.topicContext }) ??
    composeFromBrief(input.userMessage, input.topicContext ?? "");
  if (!composition || composition.colorName) return composition;
  const named = colorInMessage(input.userMessage);
  return named ? { ...composition, colorName: named } : composition;
}

function phasePlan(composition: Composition, phase: CompositionPhase): string {
  const body = describeComposition(composition);
  if (phase === "outline") return `Phase: outline\nConfirm these nodes before any edges are drawn.\n\n${body}`;
  if (phase === "structure") return `Phase: structure\nConfirm these edges and the layout.\n\n${body}`;
  return `Phase: style\nConfirm the drawing. Apply a named color only when the user asked for one.\n\n${body}`;
}

/**
 * Templates and researched topics are a reference. Jev is asked three times:
 * node outline, edges, then style. Apply uses the template even when confirm
 * is lukewarm. Noop and clarify leave the mxfile alone. A non-blank canvas is
 * not replaced by the template.
 */
async function runComposition(input: OrchestratorContext): Promise<KevTurnResult> {
  const composition = drawingFor(input);
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

  const xml = renderComposition(composition);
  const canvas = templateCanvasPlan(input.currentXml, xml);
  if (canvas === "unchanged" || sameMxfile(xml, input.originalXml)) {
    return turn(input, {
      reply: UNCHANGED_DIAGRAM_REPLY,
      updatedXml: input.originalXml,
      intent: "noop",
      slots: withPalette(input.reading.slots),
      steps: [],
      confidence: input.reading.confidence,
    });
  }
  if (canvas === "keep") {
    return turn(input, {
      reply: KEPT_CANVAS_REPLY,
      updatedXml: input.originalXml,
      intent: "noop",
      slots: withPalette(input.reading.slots),
      steps: [],
      confidence: input.reading.confidence,
    });
  }

  const steps: KevStep[] = [];
  let confidence = input.reading.confidence;
  for (const step of COMPOSITION_PHASES) {
    const payload = await callSystemOne(
      buildCompositionRequest({
        userMessage: input.userMessage,
        summary: safeSummary(input.currentXml),
        plan: phasePlan(composition, step.phase),
        phase: step.phase,
        model: input.model,
        previousXml: input.previousXml,
        currentXml: input.currentXml,
        diagramDiff: input.diagramDiff,
        topicContext: input.topicContext,
      }),
    );
    const answers = systemOneAnswers(payload);
    if (!answers) throw new KevUnreachableError("Kev returned an unreadable System One response.");
    const next = readChoiceAnswer(answers.next);
    const confirm = readNoulAnswer(answers.confirm);
    const choice = next?.choice.toLowerCase() ?? null;
    if (typeof next?.confidence === "number") confidence = next.confidence;
    steps.push({
      detail: step.detail,
      intent: "add_shape",
      accepted: acceptTemplateStep(choice, confirm),
      confirm,
      choice,
    });
    if (!acceptTemplateStep(choice, confirm)) {
      // A mismatched preset used to clarify with Client → App → Postgres.
      // Named services, steps, actors, and states are already in the prompt, so
      // outline confirm must not ask for them again. An explicit noop still
      // leaves the canvas alone.
      const named =
        choice !== "noop" &&
        choice !== "skip" &&
        (Boolean(composition.grounded) || (choice === "clarify" && isStateMachineRequest(input.userMessage)));
      if (named) {
        const last = steps[steps.length - 1];
        if (last) last.accepted = true;
        const decision = compositionDecision(composition, xml);
        return turn(input, {
          reply: decision.reply,
          updatedXml: xml,
          intent: decision.intent,
          slots: decision.slots,
          steps,
          confidence,
        });
      }
      return turn(input, {
        reply: choice === "clarify" ? CLARIFY_NODES : UNCHANGED_DIAGRAM_REPLY,
        updatedXml: input.originalXml,
        intent: choice === "clarify" ? "clarify" : "noop",
        slots: withPalette(input.reading.slots),
        steps,
        confidence,
      });
    }
  }

  const decision = compositionDecision(composition, xml);
  return turn(input, {
    reply: decision.reply,
    updatedXml: xml,
    intent: decision.intent,
    slots: decision.slots,
    steps,
    confidence,
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
/**
 * A template step is used when the model applies it. A lukewarm confirm does
 * not veto an explicit apply. Noop and clarify set the template aside.
 */
export function acceptTemplateStep(choice: string | null, confirm: number | null): boolean {
  if (choice === "noop" || choice === "clarify" || choice === "skip") return false;
  if (choice === "apply") return true;
  return confirm !== null && confirm >= NOUL_YES;
}

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
  // A layout step already carries the user's direction. Do not let a gate
  // answer turn an unspecified chain into a column.
  if (!proposal.slots.layout && proposal.intent === "layout" && (layout === "horizontal" || layout === "vertical")) {
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
    reply: UNCHANGED_DIAGRAM_REPLY,
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
  const unchanged = sameMxfile(body.updatedXml, input.originalXml);
  const result: KevTurnResult = {
    reply: unchanged ? softenUnchangedReply(body.reply, true) : body.reply.trim() || "Done.",
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
