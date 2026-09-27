"use client";

import { Button } from "@/components/ui/button";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-2xl font-medium tracking-tight">The workspace stopped.</p>
      <p className="max-w-md text-sm text-muted-foreground">{error.message || "Something broke while rendering the editor."}</p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
