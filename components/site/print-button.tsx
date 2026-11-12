"use client";

/** Opens the browser's print dialog, where a guest can print the page or save it as a PDF. Hidden when printing. */
export function PrintButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-11 items-center justify-center rounded-full border border-ink px-5 text-sm hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary print:hidden"
    >
      {children}
    </button>
  );
}
