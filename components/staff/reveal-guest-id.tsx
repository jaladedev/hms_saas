"use client";

import { useEffect, useState, useTransition } from "react";
import { GUEST_ID_TYPE_LABEL, isGuestIdType } from "@/lib/staff/guest-id";
import type { RevealedGuestId } from "@/lib/staff/guest-actions";

/**
 * Shows a guest's full ID number on request, for people who hold guest.id_view. Each press asks the server (which writes an audit row),
 * the number is kept only in this component's memory, and it hides itself again after 30 seconds. Nothing is stored in the browser.
 */
export function RevealGuestId({
  guestId,
  reveal,
  buttonClass,
}: {
  guestId: string;
  reveal: (guestId: string) => Promise<RevealedGuestId>;
  buttonClass: string;
}) {
  const [shown, setShown] = useState<{ id_type: string; id_number: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 30_000);
    return () => clearTimeout(t);
  }, [shown]);

  return (
    <div className="mt-2">
      {shown ? (
        <p className="text-sm" role="status">
          {isGuestIdType(shown.id_type) ? GUEST_ID_TYPE_LABEL[shown.id_type] : "ID"}: <span className="font-mono font-medium">{shown.id_number}</span>{" "}
          <button type="button" onClick={() => setShown(null)} className={`${buttonClass} ml-2`}>
            Hide
          </button>
        </p>
      ) : (
        <button
          type="button"
          disabled={pending}
          className={buttonClass}
          onClick={() =>
            start(async () => {
              setFailed(false);
              const r = await reveal(guestId);
              if (r.ok) setShown({ id_type: r.id_type, id_number: r.id_number });
              else setFailed(true);
            })
          }
        >
          {pending ? "Showing…" : "Show full number"}
        </button>
      )}
      {failed && <p className="mt-1 text-xs text-muted">The number could not be shown.</p>}
      {!shown && !failed && <p className="mt-1 text-xs text-muted">Each time you show it, the view is recorded in the audit trail.</p>}
    </div>
  );
}
