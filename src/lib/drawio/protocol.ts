/**
 * diagrams.net embed protocol (JSON).
 *
 * Host page embeds:
 *   https://embed.diagrams.net/?embed=1&proto=json&configure=1&libraries=1&ui=min
 *
 * Sequence:
 * 1. Iframe posts { event: "configure" } and waits.
 * 2. Host replies { action: "configure", config }.
 * 3. Iframe posts { event: "init" }.
 * 4. Host replies { action: "load", xml, autosave: 1, fit: 1, dark: 0 }.
 * 5. Iframe posts { event: "load", bounds, ... } once the model is open.
 * 6. Edits post { event: "autosave", xml }. Save posts { event: "save", xml }.
 *    The embed stays editable. Nothing in this protocol sets readOnly or locked.
 * 7. Host reads the live model with
 *    { action: "export", format: "xml", uncompressed: true, compressed: false }
 *    and receives { event: "export", xml }. The host also exports on blur,
 *    when the tab hides, and on an idle interval so chat sees hand edits.
 * 8. After Kev returns XML, the host posts { action: "load", xml }, waits for
 *    { event: "load" }, then exports again and stores that confirmed mxfile.
 * 9. { action: "spinner", show, message } and { action: "status", message, modified }
 *    drive the editor chrome while Kev is applying. Editing is not blocked while chat is idle.
 *
 * `xml` may be an mxfile, a bare mxGraphModel, or a compressed diagram payload.
 * The host keeps the previous XML if a load comes back with an error.
 */

export const DRAWIO_ORIGIN = "https://embed.diagrams.net";

export const DRAWIO_EMBED_URL =
  "https://embed.diagrams.net/?embed=1&proto=json&configure=1&libraries=1&ui=min";

export const DRAWIO_CONFIG = {
  defaultFonts: ["Helvetica"],
  defaultVertexStyle: {
    rounded: "1",
    whiteSpace: "wrap",
    html: "1",
  },
  defaultEdgeStyle: {
    edgeStyle: "orthogonalEdgeStyle",
    rounded: "1",
    orthogonalLoop: "1",
    jettySize: "auto",
    html: "1",
    endArrow: "classic",
    endFill: "1",
    strokeColor: "#64748b",
  },
} as const;

export interface DrawioMessage {
  event?: string;
  action?: string;
  xml?: string;
  data?: string;
  error?: string | null;
  exit?: boolean;
  modified?: boolean;
  format?: string;
}

export function isDrawioOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "embed.diagrams.net" || hostname.endsWith(".diagrams.net");
  } catch {
    return false;
  }
}

export function parseDrawioMessage(data: unknown): DrawioMessage | null {
  if (typeof data === "string") {
    if (!data) return null;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed as DrawioMessage;
    } catch {
      return null;
    }
  }
  if (data && typeof data === "object") return data as DrawioMessage;
  return null;
}

export function exportMessage() {
  return {
    action: "export" as const,
    format: "xml" as const,
    uncompressed: true,
    compressed: false,
  };
}

export function loadMessage(xml: string) {
  return {
    action: "load" as const,
    xml,
    autosave: 1,
    dark: 0,
    fit: 1,
    maxFitScale: 1,
    border: 28,
    title: "Architecture",
    noExitBtn: 1,
    saveAndExit: 0,
    modified: 0,
  };
}
