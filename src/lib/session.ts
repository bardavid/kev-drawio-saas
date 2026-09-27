export interface UndoableMessage {
  id: string;
  role: "user" | "assistant";
  /** Diagram mxfile from before this user message. Absent on assistant messages. */
  beforeXml?: string;
}

/**
 * History rewind from one user message.
 * Drops that message and everything after it, and returns the diagram snapshot
 * stored when the message was sent.
 */
export function rewindToUserMessage<T extends UndoableMessage>(
  messages: T[],
  messageId: string,
): { messages: T[]; xml: string } | null {
  const index = messages.findIndex((message) => message.id === messageId);
  const target = index >= 0 ? messages[index] : undefined;
  if (!target || target.role !== "user" || !target.beforeXml) return null;
  return { messages: messages.slice(0, index), xml: target.beforeXml };
}
