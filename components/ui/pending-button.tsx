"use client";

import { useFormStatus } from "react-dom";
import { Spinner } from "./spinner";

/**
 * A submit button that knows when its form is being sent. While it is, the button is disabled (so a double tap cannot
 * send twice), shows a spinner and `pendingLabel`, and, with `progress`, a moving bar under it. Put it inside the
 * `<form>`; it needs no props from the page. Pass the usual look as `className` (for example `buttonPrimary`).
 *
 * `progress` is indeterminate on purpose: a server action gives the browser no byte count, so a percentage would be invented.
 */
export function PendingButton({
  children,
  pendingLabel = "Saving…",
  className,
  progress = false,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  progress?: boolean;
}) {
  const { pending } = useFormStatus();
  const button = (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className={`${className ?? ""} inline-flex items-center justify-center gap-2`}
    >
      {pending ? <Spinner /> : null}
      {pending ? pendingLabel : children}
    </button>
  );
  const status = (
    <span role="status" aria-live="polite" className="sr-only">
      {pending ? pendingLabel : ""}
    </span>
  );
  // Without the progress bar there is no wrapper, so the button sits in its form exactly where a plain button did.
  if (!progress) {
    return (
      <>
        {button}
        {status}
      </>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1.5">
      {button}
      {pending ? (
        <span role="progressbar" aria-label={pendingLabel} className="block h-1 w-full overflow-hidden rounded bg-line">
          <span className="indeterminate-bar block h-full w-1/3 rounded bg-primary" />
        </span>
      ) : null}
      {status}
    </span>
  );
}
