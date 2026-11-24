"use client";

import { useEffect, useState } from "react";
import { rescueInflight } from "@/lib/offline/queue-store";
import {
  CONNECTION_ERROR_BODY,
  CONNECTION_ERROR_TITLE,
  ERROR_PAGE_BODY,
  ERROR_PAGE_TITLE,
  RESCUED_BODY,
  errorReference,
  isConnectionError,
} from "@/lib/observability/ui-text";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const ref = errorReference(error.digest);
  const connection = isConnectionError(error);
  // A change that was being sent when the connection failed is kept on this computer, so it is not lost with the page.
  const [rescued, setRescued] = useState<string | null>(null);
  useEffect(() => {
    if (!connection) return;
    const label = rescueInflight();
    if (label) setRescued(label);
  }, [connection]);
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">{connection ? CONNECTION_ERROR_TITLE : ERROR_PAGE_TITLE}</h1>
      <p className="mt-2 text-sm text-neutral-600">{connection ? CONNECTION_ERROR_BODY : ERROR_PAGE_BODY}</p>
      {rescued && (
        <p role="status" className="mt-3 rounded-md border px-3 py-2 text-sm">
          <strong>{rescued}</strong> {RESCUED_BODY}
        </p>
      )}
      {ref && <p className="mt-2 text-xs text-neutral-500">Reference: {ref}</p>}
      <button type="button" onClick={reset} className="mt-6 rounded-md border px-4 py-2 text-sm">
        Try again
      </button>
    </main>
  );
}
