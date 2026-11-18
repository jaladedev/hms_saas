import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { saveEvent } from "@/lib/staff/event-actions";
import { toInputLocal } from "@/lib/staff/events";

export type EventItem = {
  id: string;
  title: string;
  body: string;
  venue_id: string | null;
  starts_at: string;
  ends_at: string;
  max_per_order: number;
  sales_close_at: string | null;
};

export function EventForm({
  propertyId,
  venues,
  item,
}: {
  propertyId: string;
  venues: { id: string; name: string }[];
  item: EventItem | null;
}) {
  return (
    <form action={saveEvent} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="eventId" value={item?.id ?? ""} />
      <label className="block text-sm sm:col-span-2">
        Title
        <input name="title" required maxLength={80} defaultValue={item?.title ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm sm:col-span-2">
        About (optional)
        <textarea name="body" maxLength={500} rows={3} defaultValue={item?.body ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm">
        Starts
        <input
          type="datetime-local"
          name="startsAt"
          required
          defaultValue={toInputLocal(item?.starts_at)}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm">
        Ends
        <input type="datetime-local" name="endsAt" required defaultValue={toInputLocal(item?.ends_at)} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm">
        Venue (optional; holds its time)
        <select name="venueId" defaultValue={item?.venue_id ?? ""} className={`${inputClass} mt-1`}>
          <option value="">No venue</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Most tickets in one order
        <input
          name="maxPerOrder"
          required
          inputMode="numeric"
          defaultValue={String(item?.max_per_order ?? 10)}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm">
        Online sales close (optional)
        <input
          type="datetime-local"
          name="salesCloseAt"
          defaultValue={toInputLocal(item?.sales_close_at)}
          className={`${inputClass} mt-1`}
        />
      </label>
      <div className="sm:col-span-2">
        <PendingButton className={buttonPrimary} pendingLabel="Saving…">
          {item ? "Save event" : "Create event"}
        </PendingButton>
      </div>
    </form>
  );
}
