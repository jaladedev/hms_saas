"use client";

import { buttonQuiet } from "@/components/staff/ui";

// Opens the browser's print dialog. Hidden on paper. The reports have their own print rules (the sidebar,
// filters, links and this button drop out; the tables keep their full width), so what prints is the report itself.
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className={`${buttonQuiet} print:hidden`}>
      Print
    </button>
  );
}
