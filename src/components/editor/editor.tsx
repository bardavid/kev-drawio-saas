"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { ChatPanel, type ChatItem } from "@/components/editor/chat-panel";
import { DiagramFrame, type DiagramFrameHandle } from "@/components/editor/diagram-frame";
import { Button } from "@/components/ui/button";
import { STARTER_XML } from "@/lib/drawio/starter";
import { noteEditorXml, noteHostXml, previousForTurn, type DiagramSync } from "@/lib/drawio/sync";
import type { DiagramSlots, Intent, KevTurnResult } from "@/lib/kev/types";
import { rewindToUserMessage } from "@/lib/session";
import { cn } from "@/lib/utils";

interface DrawHistoryState {
  drawai: true;
  index: number;
  messages: ChatItem[];
  xml: string;
}

type Pane = "chat" | "diagram";

function looksLikeDiagram(xml: string): boolean {
  return xml.includes("<mxfile") || xml.includes("<mxGraphModel");
}

function canvasLooksBlank(xml: string): boolean {
  return !xml.includes('vertex="1"') && !xml.includes("vertex='1'");
}

function isHistoryState(value: unknown): value is DrawHistoryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DrawHistoryState>;
  return state.drawai === true && typeof state.index === "number" && typeof state.xml === "string" && Array.isArray(state.messages);
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
  const ignorePopRef = useRef(false);
  const historyIndexRef = useRef(0);
  const messagesRef = useRef<ChatItem[]>([]);
  const showXmlRef = useRef<(next: string) => Promise<void>>(async () => {});
  const commitMessagesRef = useRef<(next: ChatItem[]) => void>(() => {});
  const syncRef = useRef<DiagramSync>({
    currentXml: STARTER_XML,
    baselineXml: STARTER_XML,
    acceptEcho: true,
  });
  const [xml, setXml] = useState(STARTER_XML);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [pane, setPane] = useState<Pane>("chat");
  const mdUp = useMdUp();

  function commitSync(next: DiagramSync) {
    syncRef.current = next;
    setXml(next.currentXml);
  }

  function commitMessages(next: ChatItem[]) {
    messagesRef.current = next;
    setMessages(next);
  }

  function pushHistory(nextMessages: ChatItem[], nextXml: string) {
    historyIndexRef.current += 1;
    const state: DrawHistoryState = {
      drawai: true,
      index: historyIndexRef.current,
      messages: nextMessages,
      xml: nextXml,
    };
    window.history.pushState(state, "");
  }

  async function showXml(next: string) {
    applyingRef.current = true;
    syncRef.current = { ...syncRef.current, acceptEcho: false };
    try {
      const confirmed = (await frameRef.current?.applyAndConfirm(next)) ?? next;
      adoptHostXml(looksLikeDiagram(confirmed) ? confirmed : next);
    } catch {
      adoptHostXml(next);
      frameRef.current?.load(next);
    } finally {
      applyingRef.current = false;
    }
  }

  function rememberEditorXml(next: string) {
    if (sendingRef.current) return;
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
    commitMessagesRef.current = commitMessages;
    showXmlRef.current = showXml;
  });

  useEffect(() => {
    if (!isHistoryState(window.history.state)) {
      const initial: DrawHistoryState = { drawai: true, index: 0, messages: [], xml: STARTER_XML };
      window.history.replaceState(initial, "");
    }
    function onPop(event: PopStateEvent) {
      if (ignorePopRef.current) {
        ignorePopRef.current = false;
        return;
      }
      if (sendingRef.current) {
        ignorePopRef.current = true;
        window.history.forward();
        return;
      }
      if (!isHistoryState(event.state)) return;
      historyIndexRef.current = event.state.index;
      commitMessagesRef.current(event.state.messages);
      void showXmlRef.current(event.state.xml);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
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
    const beforeXml = syncRef.current.currentXml;
    const userMessage: ChatItem = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      beforeXml,
      historyIndex: historyIndexRef.current,
    };
    const history = [...messagesRef.current, userMessage];
    commitMessages(history);
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
      commitMessages([...messagesRef.current, assistant]);
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
      pushHistory(messagesRef.current, syncRef.current.currentXml);
      sendingRef.current = false;
      setPending(false);
    }
  }

  function undoFrom(id: string) {
    if (sendingRef.current || applyingRef.current) return;
    const current = messagesRef.current;
    const target = current.find((message) => message.id === id);
    if (!target || target.role !== "user") return;
    if (typeof target.historyIndex === "number") {
      const delta = historyIndexRef.current - target.historyIndex;
      if (delta > 0) {
        window.history.go(-delta);
        return;
      }
    }
    const rewound = rewindToUserMessage(current, id);
    if (!rewound) return;
    commitMessages(rewound.messages);
    void showXml(rewound.xml);
  }

  async function resetAll() {
    if (sendingRef.current) return;
    commitMessages([]);
    setDraft("");
    await showXml(STARTER_XML);
    pushHistory(messagesRef.current, syncRef.current.currentXml);
  }

  return (
    <div className="flex h-dvh max-w-full flex-col overflow-hidden overscroll-none bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <header className="relative z-30 flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-4">
        <BrandMark />
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1.5 px-3 md:h-8"
            onClick={() => void resetAll()}
            disabled={pending || (messages.length === 0 && canvasLooksBlank(xml))}
            aria-label="Clear chat and diagram"
            data-testid="clear-session"
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
          <ChatPanel
            messages={messages}
            draft={draft}
            pending={pending}
            onDraft={setDraft}
            onSend={send}
            onUndo={undoFrom}
          />
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
            locked={pending}
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
