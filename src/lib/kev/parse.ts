import { isShapeKind } from "@/lib/drawio/styles";
import { KevError } from "@/lib/kev/client";
import {
  isIntent,
  isMutatingIntent,
  type DiagramOperation,
  type DiagramSlots,
  type KevDecision,
} from "@/lib/kev/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function asHex(value: unknown): string | null {
  const text = asText(value, 16);
  if (!text) return null;
  const match = text.match(/^#?[0-9a-fA-F]{6}$/);
  if (!match) return null;
  return text.startsWith("#") ? text.toLowerCase() : `#${text.toLowerCase()}`;
}

export function slotsFromUnknown(value: unknown): DiagramSlots {
  const record = asRecord(value) ?? {};
  const shape = asText(record.shape, 32);
  const layout = asText(record.layout, 16);
  const place = asText(record.place, 16);
  return {
    label: asText(record.label),
    shape: isShapeKind(shape) ? shape : null,
    fillColor: asHex(record.fillColor),
    strokeColor: asHex(record.strokeColor),
    colorName: asText(record.colorName, 32)?.toLowerCase() ?? null,
    from: asText(record.from),
    to: asText(record.to),
    target: asText(record.target),
    newLabel: asText(record.newLabel),
    edgeLabel: asText(record.edgeLabel, 80),
    layout: layout === "horizontal" || layout === "vertical" ? layout : null,
    place: place === "before" || place === "after" ? place : null,
    sequence: sequenceFromUnknown(record.sequence),
  };
}

function sequenceFromUnknown(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const labels = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);
  return labels.length > 0 ? labels : null;
}

export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export function decisionFromUnknown(value: unknown): KevDecision {
  const record = asRecord(value);
  if (!record) throw new KevError("The model returned an unreadable decision.", 502);
  const intentText = asText(record.intent, 32);
  if (!intentText || !isIntent(intentText)) {
    throw new KevError("The model returned an unknown intent.", 502);
  }
  const slots = slotsFromUnknown(record.slots);
  const operations: DiagramOperation[] = [];
  if (Array.isArray(record.operations)) {
    for (const item of record.operations.slice(0, 8)) {
      const op = asRecord(item);
      const opIntent = op ? asText(op.intent, 32) : null;
      if (!op || !opIntent || !isMutatingIntent(opIntent)) continue;
      operations.push({ intent: opIntent, slots: slotsFromUnknown(op.slots) });
    }
  }
  const reply = asText(record.reply, 600) ?? "";
  const updatedXml = typeof record.updatedXml === "string" ? record.updatedXml.trim() : "";
  return {
    intent: intentText,
    slots,
    operations,
    reply,
    updatedXml: updatedXml.length > 0 ? updatedXml : null,
  };
}

export function payloadMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  const error = record?.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 300);
  const nested = asRecord(error);
  if (typeof nested?.message === "string" && nested.message.trim()) {
    return nested.message.trim().slice(0, 300);
  }
  return fallback;
}
