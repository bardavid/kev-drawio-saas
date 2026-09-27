import type { ChatMessage, KevDecision, KevMode } from "@/lib/kev/types";

export class KevError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "KevError";
    this.status = status;
  }
}

export interface KevRequest {
  messages: ChatMessage[];
  /** Live mxfile, including any edits made in the draw.io canvas. */
  currentXml: string;
  /** Last mxfile from before the user's manual edits, when it differs. */
  previousXml?: string | null;
  /** Added, removed, and changed cell ids and values. */
  diagramDiff?: string;
}

/** Language-model or demo classifier. Kev System One is a separate call in front of the XML writer. */
export interface KevClient {
  readonly mode: KevMode;
  readonly model?: string;
  decide(input: KevRequest): Promise<KevDecision>;
}
