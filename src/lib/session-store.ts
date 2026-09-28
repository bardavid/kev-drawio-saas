/**
 * Same-browser session for the open diagram and the chat transcript.
 * localStorage, not a cookie: mxfile XML plus message history will not fit in a cookie.
 * Callers must read this in the browser. The server has no storage.
 */
import { STARTER_XML } from "@/lib/drawio/starter";
import type { DiagramSlots, Intent } from "@/lib/kev/types";

export const SESSION_STORAGE_KEY = "draw.ai.session";
const SESSION_VERSION = 1;

const INTENTS = new Set<Intent>([
  "add_shape",
  "edit_shape",
  "delete_shape",
  "connect",
  "layout",
  "style",
  "clarify",
  "noop",
]);

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Chat row as shown, plus the undo snapshot taken before a user message. */
export interface PersistedChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  intent?: Intent;
  slots?: DiagramSlots;
  repaired?: boolean;
  beforeXml?: string;
  historyIndex?: number;
}

export interface PersistedSession {
  version: 1;
  messages: PersistedChatMessage[];
  xml: string;
}

export function browserLocalStorage(): KeyValueStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function looksLikeDiagram(xml: string): boolean {
  return xml.includes("<mxfile") || xml.includes("<mxGraphModel");
}

/** Shapes, a transcript, or a compressed mxfile are worth keeping. A blank page is not. */
export function sessionWorthKeeping(messageCount: number, xml: string): boolean {
  if (messageCount > 0) return true;
  if (!looksLikeDiagram(xml)) return false;
  if (xml.includes('vertex="1"') || xml.includes("vertex='1'")) return true;
  // Compressed diagrams hide cell markup. Keep them so a hand edit is not dropped.
  if (!xml.includes("<mxCell")) return xml.trim() !== STARTER_XML.trim();
  return false;
}

/** What the editor should open with. Missing or unreadable storage is a blank page. */
export function sessionForLoad(storage: KeyValueStorage | null): { messages: PersistedChatMessage[]; xml: string } {
  if (!storage) return { messages: [], xml: STARTER_XML };
  const saved = readStoredSession(storage);
  if (!saved) return { messages: [], xml: STARTER_XML };
  return { messages: saved.messages, xml: saved.xml };
}

export function readStoredSession(storage: KeyValueStorage): PersistedSession | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return normalizeSession(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeStoredSession(
  storage: KeyValueStorage,
  session: { messages: readonly PersistedChatMessage[]; xml: string },
): void {
  try {
    if (!sessionWorthKeeping(session.messages.length, session.xml)) {
      storage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    const payload: PersistedSession = {
      version: SESSION_VERSION,
      messages: session.messages.map(serializeMessage),
      xml: session.xml,
    };
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private mode or a full quota. The in-memory session still works for this page.
  }
}

export function clearStoredSession(storage: KeyValueStorage): void {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Same as a failed write: the screen can still reset.
  }
}

function serializeMessage(message: PersistedChatMessage): PersistedChatMessage {
  const next: PersistedChatMessage = {
    id: message.id,
    role: message.role,
    content: message.content,
  };
  if (message.intent) next.intent = message.intent;
  if (message.slots) next.slots = message.slots;
  if (typeof message.repaired === "boolean") next.repaired = message.repaired;
  if (message.beforeXml) next.beforeXml = message.beforeXml;
  if (typeof message.historyIndex === "number") next.historyIndex = message.historyIndex;
  return next;
}

function normalizeSession(value: unknown): PersistedSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== SESSION_VERSION) return null;
  const messages = Array.isArray(record.messages)
    ? record.messages.flatMap((item) => {
        const message = messageFromUnknown(item);
        return message ? [message] : [];
      })
    : [];
  const xml =
    typeof record.xml === "string" && looksLikeDiagram(record.xml)
      ? record.xml
      : messages.length > 0
        ? STARTER_XML
        : "";
  if (!sessionWorthKeeping(messages.length, xml)) return null;
  return { version: SESSION_VERSION, messages, xml };
}

function messageFromUnknown(value: unknown): PersistedChatMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || message.id.length === 0) return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (typeof message.content !== "string") return null;
  const next: PersistedChatMessage = {
    id: message.id,
    role: message.role,
    content: message.content,
  };
  if (typeof message.intent === "string" && INTENTS.has(message.intent as Intent)) {
    next.intent = message.intent as Intent;
  }
  if (isPlainObject(message.slots)) next.slots = message.slots as DiagramSlots;
  if (typeof message.repaired === "boolean") next.repaired = message.repaired;
  if (typeof message.beforeXml === "string" && looksLikeDiagram(message.beforeXml)) next.beforeXml = message.beforeXml;
  if (typeof message.historyIndex === "number" && Number.isInteger(message.historyIndex) && message.historyIndex >= 0) {
    next.historyIndex = message.historyIndex;
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
