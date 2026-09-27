"use client";

import { ArrowUp } from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DiagramSlots, Intent } from "@/lib/kev/types";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  intent?: Intent;
  slots?: DiagramSlots;
  repaired?: boolean;
  /** Diagram XML from before this user message. Undo restores it. */
  beforeXml?: string;
  /** Browser history index to rewind to. */
  historyIndex?: number;
}

function slotLine(slots: DiagramSlots | undefined): string {
  if (!slots) return "";
  const parts: string[] = [];
  if (slots.shape) parts.push(slots.shape);
  if (slots.label) parts.push(slots.label);
  if (slots.newLabel) parts.push(`→ ${slots.newLabel}`);
  if (slots.target && slots.target !== slots.label) parts.push(slots.target);
  if (slots.from || slots.to) parts.push([slots.from, slots.to].filter(Boolean).join(" → "));
  if (slots.place) parts.push(slots.place);
  if (slots.colorName) parts.push(slots.colorName);
  if (slots.fillColor && !slots.colorName) parts.push(slots.fillColor);
  if (slots.layout) parts.push(slots.layout);
  return parts.join(" · ");
}

interface ChatPanelProps {
  messages: ChatItem[];
  draft: string;
  pending: boolean;
  onDraft: (value: string) => void;
  onSend: (text: string) => void;
  onUndo?: (id: string) => void;
}

export function ChatPanel({ messages, draft, pending, onDraft, onSend, onUndo }: ChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pending]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    onSend(trimmed);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="message-list">
        <div className="flex flex-col gap-5 px-4 py-5">
          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="ml-8 sm:ml-10">
                <div className="break-words border border-border px-3 py-2 text-sm leading-6">{message.content}</div>
                {onUndo && message.beforeXml ? (
                  <div className="mt-1 flex justify-end">
                    <button
                      type="button"
                      className="h-8 px-1 text-xs text-muted-foreground disabled:opacity-40"
                      disabled={pending}
                      aria-label="Undo from this message"
                      onClick={() => onUndo(message.id)}
                    >
                      Undo
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <article key={message.id} className="mr-4 flex min-w-0 flex-col gap-1.5 sm:mr-6">
                {message.intent ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px] font-normal text-muted-foreground">
                      {message.intent}
                    </Badge>
                    {slotLine(message.slots) ? (
                      <span className="min-w-0 font-mono text-[11px] break-words text-muted-foreground">{slotLine(message.slots)}</span>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-sm leading-6 break-words">{message.content}</p>
              </article>
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        className="border-t px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="diagram-prompt">
            Diagram request
          </label>
          <Textarea
            id="diagram-prompt"
            data-testid="chat-input"
            value={draft}
            disabled={pending}
            rows={2}
            enterKeyHint="send"
            autoComplete="off"
            placeholder="Describe a diagram…"
            className="max-h-32 min-h-14 flex-1 resize-none rounded-md border-border bg-background text-base shadow-none focus-visible:ring-2 md:text-sm"
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(draft);
              }
            }}
          />
          <Button
            type="submit"
            variant="outline"
            size="icon"
            disabled={pending || !draft.trim()}
            aria-label="Send"
            className="size-11 shrink-0 touch-manipulation md:size-8"
          >
            <ArrowUp />
          </Button>
        </div>
      </form>
    </div>
  );
}
