"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import {
  DRAWIO_CONFIG,
  DRAWIO_EMBED_URL,
  DRAWIO_ORIGIN,
  exportMessage,
  isDrawioOrigin,
  loadMessage,
  parseDrawioMessage,
  type DrawioMessage,
} from "@/lib/drawio/protocol";

export interface DiagramFrameHandle {
  /** Uncompressed export of whatever is currently open. Falls back to the last XML we stored. */
  getXml: () => Promise<string>;
  load: (xml: string) => void;
  /**
   * Post a load, wait for the editor's load event, then export uncompressed XML
   * and return that confirmed mxfile. Editing is suppressed only for this window.
   */
  applyAndConfirm: (xml: string) => Promise<string>;
  setSpinner: (message: string | null) => void;
}

interface DiagramFrameProps {
  xml: string;
  /** Block canvas edits while a draw is in flight. */
  locked?: boolean;
  ignoreEditorUpdatesRef?: RefObject<boolean>;
  onXmlChange: (xml: string) => void;
  onLoad?: (message: DrawioMessage) => void;
  onError?: (message: string) => void;
}

function looksLikeXml(xml: string): boolean {
  return xml.includes("<mxfile") || xml.includes("<mxGraphModel") || xml.includes("<diagram");
}

export const DiagramFrame = forwardRef<DiagramFrameHandle, DiagramFrameProps>(function DiagramFrame(
  { xml, locked = false, ignoreEditorUpdatesRef, onXmlChange, onLoad, onError },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const loadedRef = useRef<string | null>(null);
  const latestRef = useRef(xml);
  const suppressRef = useRef(false);
  const exportWaiters = useRef<Array<(xml: string) => void>>([]);
  const exportTimer = useRef<number | null>(null);
  const loadWaiters = useRef<Array<(message: DrawioMessage) => void>>([]);
  const recompressTimer = useRef<number | null>(null);
  const onXmlChangeRef = useRef(onXmlChange);
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const lockedRef = useRef(locked);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);
  useEffect(() => {
    onXmlChangeRef.current = onXmlChange;
  }, [onXmlChange]);
  useEffect(() => {
    onLoadRef.current = onLoad;
  }, [onLoad]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const post = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(message), DRAWIO_ORIGIN);
  }, []);

  const publish = useCallback((nextXml: string) => {
    const trimmed = nextXml.trim();
    if (!trimmed) return;
    latestRef.current = trimmed;
    loadedRef.current = trimmed;
    if (suppressRef.current || ignoreEditorUpdatesRef?.current || lockedRef.current) return;
    onXmlChangeRef.current(trimmed);
  }, [ignoreEditorUpdatesRef]);

  const requestExport = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      if (!readyRef.current || !iframeRef.current?.contentWindow) {
        resolve(latestRef.current);
        return;
      }
      exportWaiters.current.push(resolve);
      if (exportWaiters.current.length > 1) return;
      if (exportTimer.current) window.clearTimeout(exportTimer.current);
      exportTimer.current = window.setTimeout(() => {
        const waiters = exportWaiters.current.splice(0);
        exportTimer.current = null;
        waiters.forEach((waiter) => waiter(latestRef.current));
      }, 1800);
      post(exportMessage());
    });
  }, [post]);

  const requestExportRef = useRef(requestExport);
  useEffect(() => {
    requestExportRef.current = requestExport;
  }, [requestExport]);

  useImperativeHandle(ref, () => ({
    getXml: () => requestExportRef.current(),
    load: (nextXml: string) => {
      latestRef.current = nextXml;
      loadedRef.current = nextXml;
      if (readyRef.current) post(loadMessage(nextXml));
    },
    applyAndConfirm: (nextXml: string) => {
      const rollback = latestRef.current;
      suppressRef.current = true;
      latestRef.current = nextXml;
      loadedRef.current = nextXml;
      if (!readyRef.current || !iframeRef.current?.contentWindow) {
        suppressRef.current = false;
        return Promise.resolve(nextXml);
      }
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (message: DrawioMessage | null) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          loadWaiters.current = loadWaiters.current.filter((waiter) => waiter !== finish);
          void (async () => {
            try {
              if (message && typeof message.error === "string" && message.error) {
                latestRef.current = rollback;
                loadedRef.current = rollback;
                post(loadMessage(rollback));
                reject(new Error(message.error));
                return;
              }
              const exported = await requestExportRef.current();
              const confirmed = looksLikeXml(exported) ? exported : nextXml;
              latestRef.current = confirmed;
              loadedRef.current = confirmed;
              resolve(confirmed);
            } catch (error) {
              latestRef.current = rollback;
              loadedRef.current = rollback;
              reject(error instanceof Error ? error : new Error("draw.io did not confirm the diagram."));
            } finally {
              suppressRef.current = false;
            }
          })();
        };
        const timer = window.setTimeout(() => finish(null), 3500);
        loadWaiters.current.push(finish);
        post(loadMessage(nextXml));
      });
    },
    setSpinner: (message: string | null) => {
      post(message ? { action: "spinner", show: true, message } : { action: "spinner", show: false });
    },
  }), [post]);

  useEffect(() => {
    const iframe = iframeRef.current;

    function onMessage(event: MessageEvent) {
      if (!iframe || event.source !== iframe.contentWindow) return;
      if (!isDrawioOrigin(event.origin)) return;
      const message = parseDrawioMessage(event.data);
      if (!message?.event) return;

      if (message.event === "configure") {
        post({ action: "configure", config: DRAWIO_CONFIG });
        return;
      }
      if (message.event === "init") {
        readyRef.current = true;
        setReady(true);
        setSlow(false);
        return;
      }
      if (message.event === "load") {
        const waited = loadWaiters.current.splice(0);
        waited.forEach((waiter) => waiter(message));
        if (waited.length === 0 && typeof message.error === "string" && message.error) {
          onErrorRef.current?.(message.error);
        }
        onLoadRef.current?.(message);
        return;
      }
      if (message.event === "autosave" || message.event === "save") {
        if (typeof message.xml === "string" && message.xml.trim()) {
          publish(message.xml);
          if (!suppressRef.current && !ignoreEditorUpdatesRef?.current) {
            if (recompressTimer.current) window.clearTimeout(recompressTimer.current);
            recompressTimer.current = window.setTimeout(() => {
              recompressTimer.current = null;
              void requestExportRef.current();
            }, 400);
          }
        } else if (!suppressRef.current && !ignoreEditorUpdatesRef?.current) {
          void requestExportRef.current();
        }
        if (message.event === "save") {
          post({ action: "status", message: "Saved in this session", modified: false });
        }
        return;
      }
      if (message.event === "export") {
        const exported = typeof message.xml === "string" && message.xml.trim() ? message.xml : latestRef.current;
        publish(exported);
        if (exportTimer.current) window.clearTimeout(exportTimer.current);
        exportTimer.current = null;
        const waiters = exportWaiters.current.splice(0);
        waiters.forEach((waiter) => waiter(exported));
      }
    }

    window.addEventListener("message", onMessage);
    if (iframe && !iframe.getAttribute("src")) iframe.src = DRAWIO_EMBED_URL;
    const timer = window.setTimeout(() => {
      if (!readyRef.current) setSlow(true);
    }, 12_000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      if (recompressTimer.current) window.clearTimeout(recompressTimer.current);
    };
  }, [ignoreEditorUpdatesRef, post, publish]);

  useEffect(() => {
    if (!ready) return;
    const pull = () => {
      if (suppressRef.current || ignoreEditorUpdatesRef?.current) return;
      void requestExportRef.current();
    };
    const onFocus = () => pull();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") pull();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(pull, 8000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [ignoreEditorUpdatesRef, ready]);

  useEffect(() => {
    if (!ready) return;
    if (xml === loadedRef.current) return;
    latestRef.current = xml;
    loadedRef.current = xml;
    post(loadMessage(xml));
  }, [post, ready, xml]);

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <iframe
        ref={iframeRef}
        title="draw.io diagram editor"
        inert={locked ? true : undefined}
        className={locked ? "pointer-events-none absolute inset-0 h-full w-full border-0" : "absolute inset-0 h-full w-full border-0"}
        data-testid="diagram-frame"
      />
      {locked && ready ? (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/50"
          aria-busy="true"
          aria-live="polite"
          data-testid="diagram-lock"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-foreground/40" />
          <span className="sr-only">Updating diagram</span>
        </div>
      ) : null}
      {!ready ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 px-6 text-center">
          <span className="size-1.5 animate-pulse rounded-full bg-foreground/40" />
          <p className="text-sm text-foreground">{slow ? "Still loading…" : "Loading diagram…"}</p>
        </div>
      ) : null}
    </div>
  );
});
