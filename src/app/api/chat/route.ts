import { STARTER_XML } from "@/lib/drawio/starter";
import { KevError } from "@/lib/kev/client";
import { describeMode, runKevTurn } from "@/lib/kev/run";
import type { ChatMessage } from "@/lib/kev/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_XML = 400_000;
const MAX_MESSAGES = 20;
const MAX_CONTENT = 8_000;

export async function GET() {
  return Response.json(describeMode());
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  try {
    const result = await runKevTurn(parsed.value);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof KevError ? error.message : "Could not update the diagram.";
    const status = error instanceof KevError ? error.status : 500;
    if (status >= 500) console.error("Kev request failed:", message);
    return Response.json({ error: message }, { status });
  }
}

function firstDiagramXml(record: { currentXml?: unknown; diagramXml?: unknown; xml?: unknown }): string | null {
  for (const value of [record.currentXml, record.diagramXml, record.xml]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function parseBody(
  body: unknown,
): { ok: true; value: { messages: ChatMessage[]; currentXml: string; previousXml?: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Request body must be an object." };
  const record = body as { messages?: unknown; currentXml?: unknown; diagramXml?: unknown; xml?: unknown; previousXml?: unknown };
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    return { ok: false, error: "messages must be a non-empty array." };
  }
  if (record.messages.length > MAX_MESSAGES) {
    return { ok: false, error: `Send at most ${MAX_MESSAGES} messages.` };
  }
  const messages: ChatMessage[] = [];
  for (const item of record.messages) {
    if (!item || typeof item !== "object") return { ok: false, error: "Each message must be an object." };
    const message = item as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") {
      return { ok: false, error: "Message roles must be user or assistant." };
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      return { ok: false, error: "Each message needs text content." };
    }
    if (message.content.length > MAX_CONTENT) {
      return { ok: false, error: "A message is too long." };
    }
    messages.push({ role: message.role, content: message.content.trim() });
  }
  if (!messages.some((message) => message.role === "user")) {
    return { ok: false, error: "Include at least one user message." };
  }
  const currentXml = firstDiagramXml(record) ?? STARTER_XML;
  if (currentXml.length > MAX_XML) return { ok: false, error: "The diagram XML is too large." };
  let previousXml: string | undefined;
  if (record.previousXml !== undefined && record.previousXml !== null) {
    if (typeof record.previousXml !== "string") return { ok: false, error: "previousXml must be a string." };
    if (record.previousXml.length > MAX_XML) return { ok: false, error: "The previous diagram XML is too large." };
    if (record.previousXml.trim()) previousXml = record.previousXml;
  }
  return { ok: true, value: { messages, currentXml, previousXml } };
}
