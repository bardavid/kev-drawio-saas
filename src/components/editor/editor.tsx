"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { ChatPanel, type ChatItem } from "@/components/editor/chat-panel";
import { DiagramFrame, type DiagramFrameHandle } from "@/components/editor/diagram-frame";
import { Button } from "@/components/ui/button";
import { STARTER_XML } from "@/lib/drawio/starter";
import { noteEditorXml, noteHostXml, previousForTurn, type DiagramSync } from "@/lib/drawio/sync";
import type { DiagramSlots, Intent, KevMode, KevTurnResult } from "@/lib/kev/types";
import { cn } from "@/lib/utils";

interface ModeInfo {
  mode: KevMode;
  model?: string;
  fallback?: boolean;
}

type Pane = "chat" | "diagram";

function looksLikeDiagram(xml: string): boolean {
  return xml.includes("<mxfile") || xml.includes("<mxGraphModel");
}

function modeLabel(mode: ModeInfo | null): string {
  if (!mode) return "";
  if (mode.mode === "demo") return "Demo";
  if (mode.mode === "kev") return mode.model || "Kev";
  if (mode.fallback) return "Fallback";
  return mode.model || "";
}

function useMdUp() {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const apply = () => setMatches(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return matches;
}

export function Editor() {
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
  const [pane, setPane] = useState<Pane>("chat");
  const mdUp = useMdUp();
  const label = modeLabel(mode);

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
        /* Chat still posts if the mode badge never arrives. */
      });
    return () => controller.abort();
  }, []);

  function showPane(next: Pane) {
    setPane(next);
    if (next === "diagram") {
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
  }

  async function send(text: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setPending(true);
    setDraft("");
    const userMessage: ChatItem = { id: crypto.randomUUID(), role: "user", content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    frameRef.current?.setSpinner("Updating diagram…");

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
        toast.error(body?.error || "Could not update the diagram.");
        return;
      }
      if (!looksLikeDiagram(body.updatedXml)) {
        toast.error("Could not load that diagram.");
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
          toast.error("Could not load that diagram.");
          commitSync({ ...syncRef.current, currentXml });
        } finally {
          applyingRef.current = false;
        }
      }
    } catch {
      toast.error("Could not update the diagram.");
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
      toast.success("Diagram reset.");
    } catch {
      adoptHostXml(STARTER_XML);
      frameRef.current?.load(STARTER_XML);
      toast.error("Could not load that diagram.");
    } finally {
      applyingRef.current = false;
    }
  }

  return (
    <div className="flex h-dvh max-w-full flex-col overflow-hidden overscroll-none bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-4">
        <BrandMark />
        <div className="flex items-center gap-1.5 sm:gap-2">
          {label ? <span className="hidden max-w-36 truncate text-xs text-muted-foreground md:inline">{label}</span> : null}
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-1.5 px-3 md:h-8"
            onClick={() => void resetDiagram()}
            disabled={pending}
            aria-label="Reset diagram"
          >
            <RotateCcw />
            <span className="hidden sm:inline">Reset</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1.5 px-3 md:h-8"
            onClick={() => setMessages([])}
            disabled={pending || messages.length === 0}
            aria-label="Clear chat"
          >
            <Trash2 />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        </div>
      </header>

      <div className="flex h-11 shrink-0 border-b md:hidden" role="tablist" aria-label="Panels">
        <button
          type="button"
          role="tab"
          id="tab-chat"
          aria-selected={pane === "chat"}
          aria-controls="chat-panel"
          className={cn(
            "h-11 flex-1 touch-manipulation text-sm",
            pane === "chat" ? "border-b border-foreground text-foreground" : "text-muted-foreground",
          )}
          onClick={() => showPane("chat")}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          id="tab-diagram"
          aria-selected={pane === "diagram"}
          aria-controls="diagram-panel"
          className={cn(
            "h-11 flex-1 touch-manipulation text-sm",
            pane === "diagram" ? "border-b border-foreground text-foreground" : "text-muted-foreground",
          )}
          onClick={() => showPane("diagram")}
        >
          Diagram
        </button>
        {label ? (
          <span className="flex max-w-24 items-center truncate px-3 text-xs text-muted-foreground">{label}</span>
        ) : null}
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <section
          id="chat-panel"
          role="tabpanel"
          aria-labelledby="tab-chat"
          aria-hidden={!mdUp && pane !== "chat"}
          className={cn(
            "min-h-0 min-w-0 flex-col md:h-full md:w-[min(42%,22rem)] md:shrink-0 md:grow-0 md:border-r",
            pane === "chat" ? "flex flex-1 md:flex-none" : "hidden md:flex",
          )}
        >
          <ChatPanel messages={messages} draft={draft} pending={pending} onDraft={setDraft} onSend={send} />
        </section>
        <section
          id="diagram-panel"
          role="tabpanel"
          aria-labelledby="tab-diagram"
          aria-hidden={!mdUp && pane !== "diagram"}
          className={cn(
            "absolute inset-0 z-0 flex min-h-0 min-w-0 flex-col md:static md:z-auto md:h-full md:min-w-0 md:flex-1",
            pane === "diagram" ? "pointer-events-auto" : "invisible pointer-events-none md:visible md:pointer-events-auto",
          )}
        >
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
              toast.error(message || "Could not load that diagram.");
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
