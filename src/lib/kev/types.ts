import type { ShapeKind } from "@/lib/drawio/styles";

/** demo: neither host is configured. kev: System One classified the turn. openai: the language model classified it. */
export type KevMode = "demo" | "openai" | "kev";

export type Intent =
  | "add_shape"
  | "edit_shape"
  | "delete_shape"
  | "connect"
  | "layout"
  | "style"
  | "clarify"
  | "noop";

export type MutatingIntent = Exclude<Intent, "clarify" | "noop">;

export interface DiagramSlots {
  label?: string | null;
  shape?: ShapeKind | null;
  fillColor?: string | null;
  strokeColor?: string | null;
  colorName?: string | null;
  from?: string | null;
  to?: string | null;
  target?: string | null;
  newLabel?: string | null;
  edgeLabel?: string | null;
  layout?: "horizontal" | "vertical" | null;
  place?: "before" | "after" | null;
}

export interface DiagramOperation {
  intent: MutatingIntent;
  slots: DiagramSlots;
}

export interface KevDecision {
  intent: Intent;
  slots: DiagramSlots;
  operations: DiagramOperation[];
  reply: string;
  /** Complete mxfile. Null when the client wants the slot mutator to write XML. */
  updatedXml: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Closed-set reading from Kev's System One response. Free-text labels are filled in later. */
export interface KevReading {
  intent: Intent;
  needsXmlEdit: boolean;
  slots: DiagramSlots;
  confidence: number | null;
  disruption: number | null;
  disruptionLegend: string | null;
  model?: string;
}

export interface KevTurnResult {
  reply: string;
  updatedXml: string;
  mode: KevMode;
  model?: string;
  intent: Intent;
  slots: DiagramSlots;
  repaired: boolean;
  /** True when Kev could not be reached and the language model classified the turn. */
  fallback?: boolean;
  confidence?: number;
}

export const INTENTS: readonly Intent[] = [
  "add_shape",
  "edit_shape",
  "delete_shape",
  "connect",
  "layout",
  "style",
  "clarify",
  "noop",
];

export function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}

export function isMutatingIntent(value: string): value is MutatingIntent {
  return isIntent(value) && value !== "clarify" && value !== "noop";
}
