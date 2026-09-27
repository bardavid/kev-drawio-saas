import { formatDiagramContext } from "@/lib/drawio/diff";
import { env } from "@/lib/env";
import type { KevClient, KevRequest } from "@/lib/kev/client";
import { KevError } from "@/lib/kev/client";
import { decisionFromUnknown, payloadMessage, stripFences } from "@/lib/kev/parse";
import { buildSystemPrompt, buildXmlWriterPrompt } from "@/lib/kev/prompt";
import { KEV_DECISION_SCHEMA } from "@/lib/kev/schema";
import type { ChatMessage, KevDecision, KevReading } from "@/lib/kev/types";

export const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

function endpoint(): string {
  const base = env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  return `${base.replace(/\/$/, "")}/chat/completions`;
}

function tokenField(model: string): Record<string, number> {
  if (/^(gpt-5|o\d)/.test(model)) return { max_completion_tokens: 6000 };
  return { max_tokens: 6000 };
}

async function postChat(body: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) throw new KevError("OPENAI_API_KEY is not set.", 500);
  const response = await fetch(endpoint(), {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

function messageContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function decisionSchemaBody(model: string, messages: Array<{ role: string; content: string }>) {
  return {
    model,
    temperature: 0.1,
    messages,
    ...tokenField(model),
  };
}

async function completeDecision(
  model: string,
  messages: Array<{ role: string; content: string }>,
): Promise<KevDecision> {
  const signal = AbortSignal.timeout(50_000);
  const baseBody = decisionSchemaBody(model, messages);
  let result = await postChat(
    {
      ...baseBody,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "kev_diagram_decision",
          strict: true,
          schema: KEV_DECISION_SCHEMA,
        },
      },
    },
    signal,
  );

  if (!result.ok && result.status === 400) {
    result = await postChat(
      {
        ...baseBody,
        response_format: { type: "json_object" },
      },
      signal,
    );
  }

  if (!result.ok) {
    throw new KevError(payloadMessage(result.payload, `The model request failed (${result.status}).`), 502);
  }

  const content = messageContent(result.payload);
  if (!content.trim()) throw new KevError("The model returned an empty decision.", 502);
  try {
    return decisionFromUnknown(JSON.parse(stripFences(content)));
  } catch (error) {
    if (error instanceof KevError) throw error;
    throw new KevError("The model returned an unreadable decision.", 502);
  }
}

function turnContext(input: {
  currentXml: string;
  previousXml?: string | null;
  diagramDiff?: string;
  request: string;
  preamble?: string;
}): string {
  const diagram = formatDiagramContext({
    currentXml: input.currentXml,
    previousXml: input.previousXml,
    diffText: input.diagramDiff?.trim() || "No cell changes since the previous diagram.",
  });
  return [input.preamble, diagram, `Request: ${input.request}`].filter(Boolean).join("\n\n");
}

export class OpenAIKevClient implements KevClient {
  readonly mode = "openai" as const;
  readonly model = env("OPENAI_MODEL") ?? OPENAI_DEFAULT_MODEL;

  async decide(input: KevRequest): Promise<KevDecision> {
    const history = input.messages.slice(-10).map((message, index, all) => {
      const isLastUser = index === all.length - 1 && message.role === "user";
      if (!isLastUser) return { role: message.role, content: message.content.slice(0, 4000) };
      return {
        role: "user" as const,
        content: turnContext({
          currentXml: input.currentXml,
          previousXml: input.previousXml,
          diagramDiff: input.diagramDiff,
          request: message.content,
        }),
      };
    });

    const messages = [{ role: "system", content: buildSystemPrompt() }, ...history];
    return completeDecision(this.model, messages);
  }
}

/** Second step: Kev already chose the intent. The model only writes the mxfile. */
export async function writeDiagramXml(input: {
  messages: ChatMessage[];
  currentXml: string;
  previousXml?: string | null;
  diagramDiff?: string;
  reading: KevReading;
}): Promise<KevDecision> {
  const model = env("OPENAI_MODEL") ?? OPENAI_DEFAULT_MODEL;
  const brief = {
    intent: input.reading.intent,
    needs_xml_edit: input.reading.needsXmlEdit,
    confidence: input.reading.confidence,
    slots: input.reading.slots,
    disruption: input.reading.disruption,
    disruption_legend: input.reading.disruptionLegend,
  };
  const history = input.messages.slice(-10).map((message, index, all) => {
    const isLastUser = index === all.length - 1 && message.role === "user";
    if (!isLastUser) return { role: message.role, content: message.content.slice(0, 4000) };
    return {
      role: "user" as const,
      content: turnContext({
        currentXml: input.currentXml,
        previousXml: input.previousXml,
        diagramDiff: input.diagramDiff,
        request: message.content,
        preamble: `Kev already decided this turn. Implement it. Do not change the intent.\n${JSON.stringify(brief)}`,
      }),
    };
  });
  return completeDecision(model, [{ role: "system", content: buildXmlWriterPrompt() }, ...history]);
}
