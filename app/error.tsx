"use client";

import {
  CONNECTION_ERROR_BODY,
  CONNECTION_ERROR_TITLE,
  ERROR_PAGE_BODY,
  ERROR_PAGE_TITLE,
  errorReference,
  isConnectionError,
} from "@/lib/observability/ui-text";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const ref = errorReference(error.digest);
  const connection = isConnectionError(error);
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">{connection ? CONNECTION_ERROR_TITLE : ERROR_PAGE_TITLE}</h1>
      <p className="mt-2 text-sm text-neutral-600">{connection ? CONNECTION_ERROR_BODY : ERROR_PAGE_BODY}</p>
      {ref && <p className="mt-2 text-xs text-neutral-500">Reference: {ref}</p>}
      <button type="button" onClick={reset} className="mt-6 rounded-md border px-4 py-2 text-sm">
        Try again
      </button>
    </main>
  );
}
