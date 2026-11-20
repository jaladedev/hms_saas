"use client";

import { useActionState } from "react";
import { API_SCOPE_LABEL, API_SCOPES, WEBHOOK_EVENTS } from "@/lib/api/keys";
import { emptyCreateState, type CreateState } from "@/lib/staff/api-access";

type Action = (prev: CreateState, formData: FormData) => Promise<CreateState>;
const field = "mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm";
const button = "rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60";

function Result({ state }: { state: CreateState }) {
  if (state.error)
    return (
      <p role="alert" className="mt-3 border-l-4 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-900">
        {state.error}
      </p>
    );
  if (!state.secret) return null;
  return (
    <div role="status" className="mt-3 border-l-4 border-primary bg-primary/5 px-3 py-2 text-sm">
      <p className="font-medium">{state.secret.label}: copy it now. It is shown only this once and cannot be shown again.</p>
      <code className="mt-1 block break-all rounded bg-surface px-2 py-1 select-all">{state.secret.value}</code>
    </div>
  );
}

export function NewKeyForm({ propertyId, action }: { propertyId: string; action: Action }) {
  const [state, formAction, pending] = useActionState(action, emptyCreateState);
  return (
    <form action={formAction}>
      <input type="hidden" name="propertyId" value={propertyId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs" htmlFor="key-name">
          Name
          <input id="key-name" name="name" required maxLength={60} placeholder="Booking widget" className={`${field} w-48`} />
        </label>
        <label className="block text-xs" htmlFor="key-limit">
          Calls a minute
          <input id="key-limit" name="limit" type="number" min={1} max={600} defaultValue={60} className={`${field} w-28`} />
        </label>
        <fieldset className="text-xs">
          <legend>What it may do</legend>
          <div className="mt-1 flex flex-wrap gap-3 text-sm">
            {API_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input type="checkbox" name="scope" value={s} defaultChecked={s !== "guests.read"} /> {API_SCOPE_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={pending} className={button}>
          Create key
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function NewWebhookForm({ propertyId, action }: { propertyId: string; action: Action }) {
  const [state, formAction, pending] = useActionState(action, emptyCreateState);
  return (
    <form action={formAction}>
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="active" value="true" />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs" htmlFor="hook-url">
          Address (https)
          <input
            id="hook-url"
            name="url"
            required
            maxLength={200}
            placeholder="https://example.com/hooks/hotel"
            className={`${field} w-80`}
          />
        </label>
        <fieldset className="text-xs">
          <legend>Events</legend>
          <div className="mt-1 flex flex-wrap gap-3 text-sm">
            {WEBHOOK_EVENTS.map((e) => (
              <label key={e} className="flex items-center gap-1">
                <input type="checkbox" name="event" value={e} defaultChecked={e === "booking.created"} /> {e}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={pending} className={button}>
          Add address
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}
