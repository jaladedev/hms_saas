import { buttonPrimary, EmptyState, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { createBooking } from "@/lib/staff/event-actions";
import { eventProperties } from "@/lib/staff/event-page-helpers";
import { EVENT_TYPE_LABEL, EVENT_TYPES } from "@/lib/staff/events";

export const dynamic = "force-dynamic";

export default async function NewBookingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, chosen } = await eventProperties("event.manage", typeof search.property === "string" ? search.property : undefined);
  if (!chosen) {
    return (
      <main className="max-w-2xl">
        <PageTitle>New booking</PageTitle>
        <EmptyState className="mt-4">You do not have permission to make event bookings.</EmptyState>
      </main>
    );
  }
  const { data } = await supabase
    .from("hotel_venues")
    .select("id, name, capacity")
    .eq("property_id", chosen.id)
    .eq("is_active", true)
    .order("sort_order");
  const venues = (data ?? []) as { id: string; name: string; capacity: number }[];
  return (
    <main className="max-w-2xl">
      <PageTitle>New venue booking</PageTitle>
      <PageIntro>Record an enquiry, or hold the slot now. Prices are added on the next page as quote lines.</PageIntro>
      <div className="mt-4">
        <Notice search={search} currency={chosen.currency} />
      </div>
      {venues.length === 0 ? (
        <EmptyState>Add a venue in Settings first.</EmptyState>
      ) : (
        <form action={createBooking} className="mt-4 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="propertyId" value={chosen.id} />
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          <label className="block text-sm sm:col-span-2">
            Venue
            <select name="venueId" required className={`${inputClass} mt-1`}>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} (up to {v.capacity})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Starts
            <input type="datetime-local" name="startsAt" required className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Ends
            <input type="datetime-local" name="endsAt" required className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Kind of event
            <select name="eventType" className={`${inputClass} mt-1`}>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EVENT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            People expected
            <input name="attendees" required inputMode="numeric" className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm sm:col-span-2">
            Title (optional)
            <input name="title" maxLength={80} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm sm:col-span-2">
            Client name
            <input name="name" required maxLength={80} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Email
            <input name="email" type="email" className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Phone
            <input name="phone" className={`${inputClass} mt-1`} />
          </label>
          <p className="text-xs text-muted sm:col-span-2">An email or a phone number is needed.</p>
          <label className="block text-sm sm:col-span-2">
            Note (optional)
            <textarea name="note" maxLength={500} rows={3} className={`${inputClass} mt-1`} />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="hold" className="accent-primary" /> Hold the slot now (needs a quote first for the deposit)
          </label>
          <div className="sm:col-span-2">
            <PendingButton className={buttonPrimary} pendingLabel="Saving…">
              Create booking
            </PendingButton>
          </div>
        </form>
      )}
    </main>
  );
}
