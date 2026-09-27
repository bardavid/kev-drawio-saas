"use client";

import { ArrowUp, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DiagramSlots, Intent, KevMode } from "@/lib/kev/types";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  intent?: Intent;
  slots?: DiagramSlots;
  repaired?: boolean;
}

const SUGGESTIONS = [
  "Add a Postgres box connected to the API service",
  "Add a Redis cache in front of the database",
  "Add an Auth service and connect the client to it",
  "Make the API box red",
  "Lay the diagram out vertically",
];

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
  mode: KevMode | null;
  model?: string;
  fallback?: boolean;
  onDraft: (value: string) => void;
  onSend: (text: string) => void;
  onClear: () => void;
}

export function ChatPanel({ messages, draft, pending, mode, model, fallback, onDraft, onSend, onClear }: ChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pending]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    onSend(trimmed);
  }

  const modeLine =
    mode === "demo"
      ? "Demo mode"
      : mode === "kev"
        ? `Kev · ${model || "kev-latest"}`
        : mode === "openai"
          ? fallback
            ? "Model · Kev unreachable"
            : model || "Model"
          : "Connecting";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 items-center justify-between gap-3 border-b px-4">
        <p className="truncate text-xs text-muted-foreground">{modeLine}</p>
        <Button type="button" variant="ghost" size="sm" onClick={onClear} disabled={pending || messages.length === 0}>
          <Trash2 />
          Clear
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="message-list">
        <div className="flex flex-col gap-5 px-4 py-5">
          {messages.length === 0 ? (
            <div className="flex flex-col gap-5">
              <p className="text-sm leading-6 text-muted-foreground">
                Edit the diagram directly, or describe a change. The next message includes the latest XML, and the diff
                if you changed the canvas yourself.
              </p>
              <div className="flex flex-col border-t">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={pending}
                    onClick={() => submit(suggestion)}
                    className="border-b py-2.5 text-left text-sm leading-5 text-foreground hover:text-muted-foreground disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="ml-10 border border-border px-3 py-2 text-sm leading-6">
                  {message.content}
                </div>
              ) : (
                <article key={message.id} className="mr-6 flex flex-col gap-1.5">
                  {message.intent ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="font-mono text-[10px] font-normal text-muted-foreground">
                        {message.intent}
                      </Badge>
                      {slotLine(message.slots) ? (
                        <span className="font-mono text-[11px] text-muted-foreground">{slotLine(message.slots)}</span>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-sm leading-6">{message.content}</p>
                  {message.repaired ? (
                    <p className="text-[11px] text-muted-foreground">Applied from the typed slots. The model XML did not validate.</p>
                  ) : null}
                </article>
              ),
            )
          )}
          {pending ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Editing the diagram…
            </p>
          ) : null}
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
          <label className="sr-only" htmlFor="kev-prompt">
            Diagram request
          </label>
          <Textarea
            id="kev-prompt"
            data-testid="chat-input"
            value={draft}
            disabled={pending}
            rows={2}
            placeholder="Add a Redis cache in front of the database"
            className="max-h-32 min-h-14 flex-1 resize-none rounded-md border-border bg-background shadow-none focus-visible:ring-2"
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(draft);
              }
            }}
          />
          <Button type="submit" variant="outline" size="icon" disabled={pending || !draft.trim()} aria-label="Send">
            <ArrowUp />
          </Button>
        </div>
        <p className="px-0.5 pt-2 text-[11px] text-muted-foreground">Enter to send. The canvas stays editable.</p>
      </form>
    </div>
  );
}
