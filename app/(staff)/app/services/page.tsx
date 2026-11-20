import Link from "next/link";
import { ServicesNotice } from "@/components/staff/services-notice";
import {
  buttonPrimary,
  buttonQuiet,
  cardClass,
  EmptyState,
  ErrorBanner,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import { BOOKING_STATUS_LABEL, nextActions, parseBookings, parseServices, SERVICE_KIND_LABEL } from "@/lib/staff/services";
import { loadServicesContext } from "@/lib/staff/services-access";
import { bookService, stepServiceBooking } from "@/lib/staff/services-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Spa, gym and laundry bookings (migration 151). Anyone with services access reads them; people who may book make and change them. A booking
 * for a guest staying here can be put on their room bill once they are checked in; a walk-in is marked done and paid outside the system.
 */
export default async function ServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadServicesContext(first(search.property));
  const heading = <PageTitle>Spa, gym and laundry</PageTitle>;
  if (loadFailed || !property)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">Services are for the owner, general manager, front desk and accountant.</p>
        )}
      </main>
    );
  const [servicesQ, bookingsQ] = await Promise.all([
    supabase
      .from("hotel_services")
      .select("id, name, kind, price_minor, duration_minutes, capacity, is_active")
      .eq("property_id", property.id)
      .order("sort_order")
      .order("name"),
    supabase
      .from("service_bookings")
      .select(
        "id, service_id, reservation_id, guest_label, starts_at, quantity, note, name_at_booking, kind_at_booking, unit_price_minor, status",
      )
      .eq("property_id", property.id)
      .order("created_at", { ascending: false })
      .limit(60),
  ]);
  const services = parseServices(servicesQ.data);
  const active = services.filter((s) => s.isActive);
  const bookings = parseBookings(bookingsQ.data);
  const money = (m: number) => formatMoney(m, property.currency);

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Book a spa treatment, a gym session or a laundry bag for a guest. A timed service cannot be booked into a slot that is already full.
        Put a booking on a guest&rsquo;s room bill once they are checked in; a walk-in is marked done and paid outside the system.
      </PageIntro>
      <p className="mt-2 flex flex-wrap gap-4 text-sm">
        {can.report && (
          <Link href="/app/services/report" className={linkClass}>
            Services report
          </Link>
        )}
        {can.manage && (
          <Link href="/app/settings/services" className={linkClass}>
            Service list and prices
          </Link>
        )}
      </p>
      <div className="mt-5">
        <ServicesNotice search={search} />
      </div>
      {(servicesQ.error || bookingsQ.error) && <ErrorBanner className="mb-5">Services could not be loaded. Reload the page.</ErrorBanner>}

      {can.book &&
        (active.length === 0 ? (
          <EmptyState>
            No services yet.{" "}
            {can.manage ? (
              <Link href="/app/settings/services" className={linkClass}>
                Add the first one.
              </Link>
            ) : (
              "The owner or general manager adds them."
            )}
          </EmptyState>
        ) : (
          <form action={bookService} className={cardClass}>
            <input type="hidden" name="propertyId" value={property.id} />
            <input type="hidden" name="key" value={crypto.randomUUID()} />
            <div className="flex flex-wrap items-end gap-3">
              <label className="block text-xs" htmlFor="serviceId">
                Service
                <select id="serviceId" name="serviceId" required className={`${inputClass} mt-1`}>
                  {active.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({money(s.priceMinor)}
                      {s.durationMinutes ? `, ${s.durationMinutes} min` : ""})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs" htmlFor="reference">
                Booking reference (guest staying here)
                <input id="reference" name="reference" maxLength={40} className={`${inputClass} mt-1 w-44`} />
              </label>
              <label className="block text-xs" htmlFor="guestLabel">
                Or walk-in name
                <input id="guestLabel" name="guestLabel" maxLength={60} className={`${inputClass} mt-1 w-40`} />
              </label>
              <label className="block text-xs" htmlFor="startsAt">
                Time (hotel time)
                <input id="startsAt" name="startsAt" type="datetime-local" className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-xs" htmlFor="quantity">
                Quantity
                <input
                  id="quantity"
                  name="quantity"
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={1}
                  className={`${inputClass} mt-1 w-20`}
                />
              </label>
              <label className="block text-xs" htmlFor="note">
                Note
                <input id="note" name="note" maxLength={200} className={`${inputClass} mt-1 w-44`} />
              </label>
              <PendingButton className={buttonPrimary}>Book</PendingButton>
            </div>
            <p className="mt-2 text-xs text-muted">
              A timed service (spa, gym) needs a time. Laundry does not; the time is only for pickup.
            </p>
          </form>
        ))}

      <section className="mt-10" aria-label="Bookings">
        <SectionTitle>Recent bookings</SectionTitle>
        {bookings.length === 0 ? (
          <EmptyState className="mt-3">No bookings yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {bookings.map((b) => (
              <li key={b.id} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {b.name} <span className="text-xs font-normal text-muted">{SERVICE_KIND_LABEL[b.kind]}</span> × {b.quantity}
                  </p>
                  <p className="text-sm">
                    {money(b.totalMinor)} · <strong>{BOOKING_STATUS_LABEL[b.status]}</strong>
                  </p>
                </div>
                <p className="text-sm text-muted">
                  {b.reservationId ? "Guest staying here" : `Walk-in: ${b.guestLabel ?? ""}`}
                  {b.startsAt ? ` · ${formatDateTime(b.startsAt, property.timezone)}` : ""}
                  {b.note ? ` · ${b.note}` : ""}
                </p>
                {can.book && nextActions(b.status, b.reservationId !== null).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {nextActions(b.status, b.reservationId !== null).map((a) => (
                      <form key={a.action} action={stepServiceBooking}>
                        <input type="hidden" name="bookingId" value={b.id} />
                        <input type="hidden" name="action" value={a.action} />
                        <PendingButton className={a.action === "charge" ? buttonPrimary : buttonQuiet}>{a.button}</PendingButton>
                      </form>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
