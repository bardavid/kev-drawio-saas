"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChatPanel, type ChatItem } from "@/components/workspace/chat-panel";
import { DiagramFrame, type DiagramFrameHandle } from "@/components/workspace/diagram-frame";
import { STARTER_XML } from "@/lib/drawio/starter";
import { noteEditorXml, noteHostXml, previousForTurn, type DiagramSync } from "@/lib/drawio/sync";
import type { DiagramSlots, Intent, KevMode, KevTurnResult } from "@/lib/kev/types";

interface ModeInfo {
  mode: KevMode;
  model?: string;
  fallback?: boolean;
}

function looksLikeDiagram(xml: string): boolean {
  return xml.includes("<mxfile") || xml.includes("<mxGraphModel");
}

export function Workspace() {
  const frameRef = useRef<DiagramFrameHandle>(null);
  const sendingRef = useRef(false);
  const applyingRef = useRef(false);
  const syncRef = useRef<DiagramSync>({
    currentXml: STARTER_XML,
    baselineXml: STARTER_XML,
    acceptEcho: true,
  });
  const [xml, setXml] = useState(STARTER_XML);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<ModeInfo | null>(null);

  function commitSync(next: DiagramSync) {
    syncRef.current = next;
    setXml(next.currentXml);
  }

  function rememberEditorXml(next: string) {
    if (!looksLikeDiagram(next)) return;
    const updated = noteEditorXml(syncRef.current, next, applyingRef.current);
    if (updated === syncRef.current) return;
    commitSync(updated);
  }

  function adoptHostXml(next: string) {
    if (!looksLikeDiagram(next)) return;
    commitSync(noteHostXml(syncRef.current, next));
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/chat", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: ModeInfo | null) => {
        if (body?.mode) setMode(body);
      })
      .catch(() => {
        /* The badge falls back to a neutral label. Chat still posts. */
      });
    return () => controller.abort();
  }, []);

  async function send(text: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setPending(true);
    setDraft("");
    const userMessage: ChatItem = { id: crypto.randomUUID(), role: "user", content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    frameRef.current?.setSpinner("Kev is editing the diagram…");

    let currentXml = syncRef.current.currentXml;
    try {
      const fresh = await (frameRef.current?.getXml() ?? Promise.resolve(syncRef.current.currentXml));
      if (looksLikeDiagram(fresh)) {
        rememberEditorXml(fresh);
        currentXml = syncRef.current.currentXml;
      }
    } catch {
      currentXml = syncRef.current.currentXml;
    }
    const previousXml = previousForTurn(syncRef.current);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((message) => ({ role: message.role, content: message.content })),
          currentXml,
          previousXml,
        }),
      });
      const body = (await response.json().catch(() => null)) as (KevTurnResult & { error?: string }) | null;
      if (!response.ok || !body || body.error || !body.updatedXml) {
        toast.error(body?.error || "Kev could not update the diagram. The previous drawing is unchanged.");
        return;
      }
      if (!looksLikeDiagram(body.updatedXml)) {
        toast.error("Kev returned XML the editor cannot load. The previous drawing is unchanged.");
        return;
      }
      const assistant: ChatItem = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: body.reply,
        intent: body.intent as Intent,
        slots: body.slots as DiagramSlots,
        repaired: body.repaired,
      };
      setMessages((current) => [...current, assistant]);
      if (body.mode) setMode({ mode: body.mode, model: body.model, fallback: body.fallback });
      if (body.updatedXml !== currentXml) {
        applyingRef.current = true;
        syncRef.current = { ...syncRef.current, acceptEcho: false };
        try {
          const confirmed = (await frameRef.current?.applyAndConfirm(body.updatedXml)) ?? body.updatedXml;
          const next = looksLikeDiagram(confirmed) ? confirmed : body.updatedXml;
          adoptHostXml(next);
        } catch {
          toast.error("draw.io could not load that XML. The previous drawing is unchanged.");
          commitSync({ ...syncRef.current, currentXml });
        } finally {
          applyingRef.current = false;
        }
      }
    } catch {
      toast.error("The request to Kev failed. The previous drawing is unchanged.");
    } finally {
      frameRef.current?.setSpinner(null);
      sendingRef.current = false;
      setPending(false);
    }
  }

  async function resetDiagram() {
    applyingRef.current = true;
    syncRef.current = { ...syncRef.current, acceptEcho: false };
    try {
      const confirmed = (await frameRef.current?.applyAndConfirm(STARTER_XML)) ?? STARTER_XML;
      adoptHostXml(looksLikeDiagram(confirmed) ? confirmed : STARTER_XML);
      toast.success("Diagram reset to the starter architecture.");
    } catch {
      adoptHostXml(STARTER_XML);
      frameRef.current?.load(STARTER_XML);
      toast.error("draw.io could not reload the starter diagram.");
    } finally {
      applyingRef.current = false;
    }
  }

  const modeLabel =
    mode?.mode === "demo"
      ? "Demo mode"
      : mode?.mode === "kev"
        ? `Kev · ${mode.model || "kev-latest"}`
        : mode?.fallback
          ? "Kev unreachable"
          : mode?.model
            ? mode.model
            : "Kev";

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-4">
        <BrandMark />
        <div className="flex items-center gap-2">
          <span
            className="hidden text-xs text-muted-foreground sm:inline"
            title={
              mode?.mode === "demo"
                ? "Neither KEV_BASE_URL nor OPENAI_API_KEY is set. A few phrases edit the diagram locally."
                : mode?.mode === "kev"
                  ? "Kev classifies the intent at KEV_BASE_URL/v1/systemone. A language model writes the mxfile when OPENAI_API_KEY is set."
                  : mode?.fallback
                    ? "Kev could not be reached. The language model classified this turn."
                    : "The language model classifies the intent and writes the mxfile."
            }
          >
            {modeLabel}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => void resetDiagram()} disabled={pending}>
            <RotateCcw />
            <span className="hidden sm:inline">Reset diagram</span>
          </Button>
          <Link href="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            Home
          </Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <section className="flex h-[46%] min-h-0 w-full shrink-0 flex-col border-b lg:h-full lg:w-[340px] lg:border-r lg:border-b-0">
          <ChatPanel
            messages={messages}
            draft={draft}
            pending={pending}
            mode={mode?.mode ?? null}
            model={mode?.model}
            fallback={mode?.fallback}
            onDraft={setDraft}
            onSend={send}
            onClear={() => setMessages([])}
          />
        </section>
        <section className="flex min-h-0 w-full flex-1 flex-col lg:h-full">
          <div className="flex h-8 shrink-0 items-center justify-between border-b px-3 text-xs text-muted-foreground">
            <span>Diagram</span>
            <span>Editable</span>
          </div>
          <DiagramFrame
            ref={frameRef}
            xml={xml}
            onXmlChange={rememberEditorXml}
            onLoad={() => {
              if (!syncRef.current.acceptEcho || applyingRef.current) return;
              void (async () => {
                const fresh = await frameRef.current?.getXml();
                if (!syncRef.current.acceptEcho || applyingRef.current || !fresh || !looksLikeDiagram(fresh)) return;
                if (syncRef.current.currentXml === syncRef.current.baselineXml) adoptHostXml(fresh);
              })();
            }}
            onError={(message) => {
              if (applyingRef.current) return;
              toast.error(message || "draw.io could not load that XML. The previous drawing is unchanged.");
              const previous = syncRef.current.baselineXml;
              commitSync(noteHostXml(syncRef.current, previous));
              frameRef.current?.load(previous);
            }}
          />
        </section>
      </div>
    </div>
  );
}
