"use client";

import dynamic from "next/dynamic";

const Editor = dynamic(() => import("@/components/editor/editor").then((mod) => mod.Editor), {
  ssr: false,
  loading: () => <div className="h-dvh bg-background" aria-busy="true" data-testid="session-pending" />,
});

/** Client-only editor so the saved session is read before any empty canvas is rendered. */
export function EditorShell() {
  return <Editor />;
}
