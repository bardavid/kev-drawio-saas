import type { ModeDescription } from "@/lib/kev/run";
import type { KevMode, KevTurnResult } from "@/lib/kev/types";

/**
 * Names that identify the decision host. They stay in server logs and internal
 * results, and are removed from anything the chat page can show.
 */
const PROVIDER_LEAK =
  /jev(?:-[\w.]+)?|typesafe|\bkev\b(?:-[\w.]+)?|system\s*one|\bKEV_[A-Z0-9_]+|\bOPENAI_[A-Z0-9_]+/i;

export type ClientChatStatus = {
  mode?: Exclude<KevMode, "kev">;
};

export type ClientChatTurn = Omit<KevTurnResult, "model" | "mode"> & {
  mode?: Exclude<KevMode, "kev">;
};

/** Public GET body. Omits the model id and does not advertise the decision host. */
export function presentChatStatus(described: ModeDescription): ClientChatStatus {
  if (described.mode === "kev") return {};
  return { mode: described.mode };
}

/** Public POST body. Drops `model` and drops `mode` when it would be `kev`. */
export function presentChatTurn(result: KevTurnResult): ClientChatTurn {
  const { model: _model, mode, reply, ...rest } = result;
  const safe: ClientChatTurn = {
    ...rest,
    reply: scrubUserText(reply, "Done."),
  };
  if (mode !== "kev") safe.mode = mode;
  return safe;
}

/** Toast copy. Diagram guidance stays; provider failures become a generic line. */
export function presentChatError(message: string): string {
  if (PROVIDER_LEAK.test(message)) return "Could not update the diagram.";
  return message;
}

export function scrubUserText(text: string, fallback: string): string {
  if (!PROVIDER_LEAK.test(text)) return text;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !PROVIDER_LEAK.test(sentence))
    .join(" ");
  return kept || fallback;
}
