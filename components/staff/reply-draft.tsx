"use client";

import { useActionState } from "react";
import { emptyDraftState, type DraftState } from "@/lib/staff/ai-draft";

type Action = (prev: DraftState, formData: FormData) => Promise<DraftState>;

/** A button that asks for a draft reply and shows it in a box to edit and copy. Nothing is sent from here. */
export function ReplyDraft({ messageId, action }: { messageId: string; action: Action }) {
  const [state, formAction, pending] = useActionState(action, emptyDraftState);
  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="id" value={messageId} />
      <button type="submit" disabled={pending} className="rounded border border-line px-3 py-1.5 text-sm disabled:opacity-60">
        {pending ? "Writing a draft..." : state.draft ? "Write another draft" : "Draft a reply with AI"}
      </button>
      {state.error && (
        <p role="alert" className="mt-2 border-l-4 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-900">
          {state.error}
        </p>
      )}
      {state.draft && (
        <div className="mt-2">
          <label htmlFor={`draft-${messageId}`} className="block text-xs text-muted">
            Draft written by AI. Read it, correct anything wrong, then send it yourself by email. It has not been sent.
          </label>
          <textarea
            id={`draft-${messageId}`}
            defaultValue={state.draft}
            key={state.draft}
            rows={7}
            className="mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm"
          />
        </div>
      )}
    </form>
  );
}
