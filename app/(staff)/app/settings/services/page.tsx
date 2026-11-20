import Link from "next/link";
import { ServicesNotice } from "@/components/staff/services-notice";
import { buttonPrimary, cardClass, ErrorBanner, inputClass, linkClass, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { minorToInput } from "@/lib/staff/money-input";
import { parseServices, SERVICE_KIND_LABEL, SERVICE_KINDS, type Service } from "@/lib/staff/services";
import { loadServicesContext } from "@/lib/staff/services-access";
import { saveService } from "@/lib/staff/services-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function ServiceForm({ propertyId, s }: { propertyId: string; s?: Service }) {
  const id = s?.id ?? "new";
  return (
    <form action={saveService} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {s && <input type="hidden" name="serviceId" value={s.id} />}
      <label className="block text-xs" htmlFor={`n-${id}`}>
        Service
        <input id={`n-${id}`} name="name" required maxLength={60} defaultValue={s?.name} className={`${inputClass} mt-1 w-44`} />
      </label>
      <label className="block text-xs" htmlFor={`k-${id}`}>
        Kind
        <select id={`k-${id}`} name="kind" defaultValue={s?.kind ?? "spa"} className={`${inputClass} mt-1`}>
          {SERVICE_KINDS.map((k) => (
            <option key={k} value={k}>
              {SERVICE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs" htmlFor={`p-${id}`}>
        Price (₦)
        <input
          id={`p-${id}`}
          name="price"
          required
          inputMode="decimal"
          defaultValue={s ? minorToInput(s.priceMinor) : ""}
          className={`${inputClass} mt-1 w-28`}
        />
      </label>
      <label className="block text-xs" htmlFor={`d-${id}`}>
        Minutes (blank = no slots)
        <input
          id={`d-${id}`}
          name="duration"
          type="number"
          min={5}
          max={480}
          defaultValue={s?.durationMinutes ?? ""}
          className={`${inputClass} mt-1 w-24`}
        />
      </label>
      <label className="block text-xs" htmlFor={`c-${id}`}>
        At once
        <input
          id={`c-${id}`}
          name="capacity"
          type="number"
          min={1}
          max={50}
          defaultValue={s?.capacity ?? 1}
          className={`${inputClass} mt-1 w-20`}
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" name="active" defaultChecked={s?.isActive ?? true} /> On
      </label>
      <PendingButton className={buttonPrimary}>{s ? "Save" : "Add service"}</PendingButton>
    </form>
  );
}

/**
 * The list of services and their prices (migration 151). Needs services.manage. Nothing is deleted: switch a service off and it leaves the
 * booking form but stays on past bookings. A new price applies to new bookings only. "At once" is how many can be booked into the same time.
 */
export default async function ServicesSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadServicesContext(first(search.property));
  const heading = <PageTitle>Spa, gym and laundry services</PageTitle>;
  if (loadFailed || !property || !can.manage)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">The service list is kept by the owner or general manager.</p>
        )}
      </main>
    );
  const q = await supabase
    .from("hotel_services")
    .select("id, name, kind, price_minor, duration_minutes, capacity, is_active")
    .eq("property_id", property.id)
    .order("sort_order")
    .order("name");
  const services = parseServices(q.data);

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        What the hotel sells: spa treatments, gym sessions, laundry. Give a time in minutes for anything booked into a slot; leave it blank
        for laundry. Nothing is deleted: switch a service off and it leaves the booking form but stays on past bookings. A new price applies
        to new bookings only. Up to 30 services. Spa, gym and laundry must be in your hotel group&rsquo;s plan.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/services" className={linkClass}>
          ← Spa, gym and laundry
        </Link>
      </p>
      <div className="mt-5">
        <ServicesNotice search={search} />
      </div>
      {q.error && <ErrorBanner className="mb-5">The list could not be loaded. Reload the page.</ErrorBanner>}
      <section aria-label="Services">
        <SectionTitle>Services</SectionTitle>
        <div className={`${cardClass} mt-3`}>
          <ServiceForm propertyId={property.id} />
        </div>
        <ul className="mt-3 grid gap-2">
          {services.map((s) => (
            <li key={s.id} className={cardClass}>
              <ServiceForm propertyId={property.id} s={s} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
