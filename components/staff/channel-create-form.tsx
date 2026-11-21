"use client";

import { useActionState } from "react";
import { CHANNEL_LABEL, CHANNELS, COLLECTS_LABEL, emptyCreateState, type CreateState } from "@/lib/staff/channel-sync";

type Action = (prev: CreateState, formData: FormData) => Promise<CreateState>;
const field = "mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm";
const button = "rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60";

/** Makes a connection and shows its key once, in this form only. */
export function NewConnectionForm({ propertyId, action }: { propertyId: string; action: Action }) {
  const [state, formAction, pending] = useActionState(action, emptyCreateState);
  return (
    <form action={formAction}>
      <input type="hidden" name="propertyId" value={propertyId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs" htmlFor="conn-channel">
          Channel
          <select id="conn-channel" name="channel" className={`${field} w-40`}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs" htmlFor="conn-label">
          Name
          <input id="conn-label" name="label" required maxLength={60} placeholder="Booking.com main" className={`${field} w-48`} />
        </label>
        <label className="block text-xs" htmlFor="conn-collects">
          Who collects payment
          <select id="conn-collects" name="collects" className={`${field} w-56`}>
            {(Object.keys(COLLECTS_LABEL) as (keyof typeof COLLECTS_LABEL)[]).map((c) => (
              <option key={c} value={c}>
                {COLLECTS_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={button}>
          Create connection
        </button>
      </div>
      {state.error && (
        <p role="alert" className="mt-3 border-l-4 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-900">
          {state.error}
        </p>
      )}
      {state.secret && (
        <div role="status" className="mt-3 border-l-4 border-primary bg-primary/5 px-3 py-2 text-sm">
          <p className="font-medium">{state.secret.label}: copy it now. It is shown only this once and cannot be shown again.</p>
          <code className="mt-1 block break-all rounded bg-surface px-2 py-1 select-all">{state.secret.value}</code>
        </div>
      )}
    </form>
  );
}
