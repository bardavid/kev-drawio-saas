export interface DiagramSync {
  currentXml: string;
  /** Last host-applied mxfile, or the editor's first echo of it. Hand edits diff against this. */
  baselineXml: string;
  /** The first XML from the editor after a host load replaces the baseline instead of counting as an edit. */
  acceptEcho: boolean;
}

export function noteEditorXml(sync: DiagramSync, next: string, applying: boolean): DiagramSync {
  if (!next.trim() || next === sync.currentXml) return sync;
  if (sync.acceptEcho && !applying) {
    return { currentXml: next, baselineXml: next, acceptEcho: false };
  }
  return { ...sync, currentXml: next };
}

export function noteHostXml(sync: DiagramSync, next: string): DiagramSync {
  return { currentXml: next, baselineXml: next, acceptEcho: false };
}

/** Omit previousXml when the user has not diverged from the last applied diagram. */
export function previousForTurn(sync: DiagramSync): string | undefined {
  return sync.baselineXml !== sync.currentXml ? sync.baselineXml : undefined;
}
