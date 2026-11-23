"use client";

import { ERROR_PAGE_BODY, ERROR_PAGE_TITLE, errorReference } from "@/lib/observability/ui-text";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const ref = errorReference(error.digest);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "4rem 1rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.25rem" }}>{ERROR_PAGE_TITLE}</h1>
        <p style={{ color: "#525252", fontSize: "0.875rem" }}>{ERROR_PAGE_BODY}</p>
        {ref && <p style={{ color: "#737373", fontSize: "0.75rem" }}>Reference: {ref}</p>}
        <button type="button" onClick={reset} style={{ marginTop: "1.5rem", padding: "0.5rem 1rem" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
