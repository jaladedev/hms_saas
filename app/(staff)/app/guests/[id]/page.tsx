import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { buttonPrimary, inputClass, Notice, linkClass, PageTitle, SectionTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { updateGuest } from "@/lib/staff/guest-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Guest = { id: string; tenant_id: string; full_name: string; email: string | null; phone: string | null; address: string | null; country_code: string | null; created_at: string };
type Stay = { id: string; property_id: string; booking_reference: string; reservation_status: string; arrival_date: string; departure_date: string; currency: string; total_minor: number };

export default async function GuestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const search = await searchParams;
  const supabase = await createClient();

  const { data } = await supabase.from("guests").select("id, tenant_id, full_name, email, phone, address, country_code, created_at").eq("id", id).maybeSingle();
  if (!data) notFound();
  const guest = data as Guest;

  const [stayQ, canEditQ, propQ] = await Promise.all([
    supabase.from("reservations").select("id, property_id, booking_reference, reservation_status, arrival_date, departure_date, currency, total_minor")
      .eq("primary_guest_id", id).order("arrival_date", { ascending: false }).limit(100),
    supabase.rpc("has_tenant_permission", { p_tenant: guest.tenant_id, p_permission: "guest.manage" }),
    supabase.from("properties").select("id, name"),
  ]);
  const stays = (stayQ.data ?? []) as Stay[];
  const canEdit = canEditQ.data === true;
  const propName = new Map(((propQ.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  const showProperty = propName.size > 1;

  return (
    <main className="max-w-4xl">
      <p className="text-sm"><Link href="/app/guests" className={linkClass}>Guests</Link></p>
      <PageTitle className="mt-2">{guest.full_name}</PageTitle>
      <p className="mt-1 text-sm text-muted">Guest since {formatDate(guest.created_at.slice(0, 10))}</p>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>

      <section aria-labelledby="details">
        <SectionTitle id="details">Contact details</SectionTitle>
        {canEdit ? (
          <form action={updateGuest} className="mt-3 grid max-w-xl gap-4 md:grid-cols-2">
            <input type="hidden" name="guestId" value={guest.id} />
            <div className="md:col-span-2">
              <label htmlFor="full_name" className="block text-sm font-medium">Full name</label>
              <input id="full_name" name="full_name" required maxLength={200} defaultValue={guest.full_name} className={inputClass} />
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium">Email</label>
              <input id="email" name="email" type="email" maxLength={254} defaultValue={guest.email ?? ""} autoCapitalize="none" spellCheck={false} className={inputClass} />
            </div>
            <div>
              <label htmlFor="phone" className="block text-sm font-medium">Phone</label>
              <input id="phone" name="phone" type="tel" maxLength={40} defaultValue={guest.phone ?? ""} className={inputClass} />
            </div>
            <div className="md:col-span-2">
              <label htmlFor="address" className="block text-sm font-medium">Address</label>
              <textarea id="address" name="address" rows={2} maxLength={500} defaultValue={guest.address ?? ""} className={inputClass} />
            </div>
            <div>
              <label htmlFor="country_code" className="block text-sm font-medium">Country code</label>
              <input id="country_code" name="country_code" maxLength={2} defaultValue={guest.country_code ?? ""} placeholder="NG" autoCapitalize="characters" className={`${inputClass} uppercase`} />
            </div>
            <div className="md:col-span-2">
              <button type="submit" className={buttonPrimary}>Save details</button>
              <p className="mt-2 max-w-prose text-xs text-muted">
                An email change applies to future bookings and messages. Emails already queued still go to the address they were queued with.
              </p>
            </div>
          </form>
        ) : (
          <dl className="mt-3 grid max-w-xl grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Email</dt><dd className="break-all">{guest.email ?? "None"}</dd>
            <dt className="text-muted">Phone</dt><dd>{guest.phone ?? "None"}</dd>
            <dt className="text-muted">Address</dt><dd>{guest.address ?? "None"}</dd>
            <dt className="text-muted">Country</dt><dd>{guest.country_code ?? "None"}</dd>
          </dl>
        )}
      </section>

      <section className="mt-10" aria-labelledby="stays">
        <SectionTitle id="stays">Bookings <span className="text-base text-muted">({stays.length})</span></SectionTitle>
        {stays.length === 0 ? <p className="mt-2 text-muted">No bookings, or you cannot see reservations.</p> : (
          <ul className="mt-2 border-t border-line">
            {stays.map((s) => (
              <li key={s.id} className="border-b border-line">
                <Link href={`/app/reservations/${s.id}`} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary">
                  <span>
                    <span className="font-medium">{s.booking_reference}</span>{" "}
                    <span className="text-sm text-muted">{s.reservation_status.replace("_", " ")}</span>
                    <span className="block text-sm text-muted">{formatDate(s.arrival_date)} to {formatDate(s.departure_date)}{showProperty && propName.get(s.property_id) ? `, ${propName.get(s.property_id)}` : ""}</span>
                  </span>
                  <span className="tabular-nums">{formatMoney(s.total_minor, s.currency)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-muted">Bookings where this person is the main guest.</p>
      </section>
    </main>
  );
}
