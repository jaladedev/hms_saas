import Link from "next/link";
import { buttonPrimary, inputClass, Notice } from "@/components/staff/ui";
import { createManualReservation } from "@/lib/staff/reservation-actions";
import { MANUAL_SOURCES, MAX_NIGHTS } from "@/lib/staff/new-reservation";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function NewReservationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, typeQ] = await Promise.all([
    supabase.from("properties").select("id, name, timezone").eq("status", "active").order("name"),
    supabase.from("room_types").select("id, property_id, name, max_adults, max_children").eq("status", "active").order("name"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const types = (typeQ.data ?? []) as { id: string; property_id: string; name: string; max_adults: number; max_children: number }[];
  // Only properties where the viewer may create bookings (the database checks again on submit).
  const allowed = (await Promise.all(properties.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "reservation.create" });
    return data === true ? p : null;
  }))).filter((p): p is (typeof properties)[number] => p !== null);
  const today = todayIn(allowed[0]?.timezone ?? "UTC", new Date());
  const many = allowed.length > 1;

  return (
    <main className="max-w-2xl">
      <p className="text-sm"><Link href="/app/reservations" className="text-primary-strong underline underline-offset-2">Reservations</Link></p>
      <h1 className="mt-2 font-display text-3xl">New reservation</h1>
      <p className="mt-2 max-w-prose text-muted">For guests who walk in or book by phone. The room is held and the booking is confirmed straight away; record any payment on the booking afterwards.</p>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>

      {allowed.length === 0 ? (
        <p className="rounded border border-line bg-white px-4 py-6 text-muted">You do not have permission to create reservations, or no property is set up yet.</p>
      ) : (
        <form action={createManualReservation} className="mt-6 grid gap-5">
          <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
          {!many && <input type="hidden" name="propertyId" value={allowed[0]!.id} />}

          <fieldset className="grid gap-4 rounded border border-line bg-white p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Stay</legend>
            {many && (
              <div className="sm:col-span-2">
                <label htmlFor="propertyId" className="block text-sm">Property</label>
                <select id="propertyId" name="propertyId" required defaultValue="" className={inputClass}>
                  <option value="" disabled>Choose…</option>
                  {allowed.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            <div className="sm:col-span-2">
              <label htmlFor="roomTypeId" className="block text-sm">Room type</label>
              <select id="roomTypeId" name="roomTypeId" required defaultValue="" className={inputClass}>
                <option value="" disabled>Choose…</option>
                {allowed.map((p) => (
                  <optgroup key={p.id} label={many ? p.name : "Room types"}>
                    {types.filter((t) => t.property_id === p.id).map((t) => (
                      <option key={t.id} value={t.id}>{t.name} (up to {t.max_adults} adults{t.max_children > 0 ? `, ${t.max_children} children` : ""})</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="arrival" className="block text-sm">Arrival</label>
              <input id="arrival" name="arrival" type="date" required min={today} defaultValue={today} className={inputClass} />
            </div>
            <div>
              <label htmlFor="departure" className="block text-sm">Departure</label>
              <input id="departure" name="departure" type="date" required min={today} className={inputClass} />
              <p className="mt-1 text-xs text-muted">Up to {MAX_NIGHTS} nights. The guest leaves on this day.</p>
            </div>
            <div>
              <label htmlFor="adults" className="block text-sm">Adults</label>
              <input id="adults" name="adults" type="number" inputMode="numeric" min={1} max={20} required defaultValue={1} className={inputClass} />
            </div>
            <div>
              <label htmlFor="children" className="block text-sm">Children</label>
              <input id="children" name="children" type="number" inputMode="numeric" min={0} max={20} defaultValue={0} className={inputClass} />
            </div>
          </fieldset>

          <fieldset className="grid gap-4 rounded border border-line bg-white p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Guest</legend>
            <div className="sm:col-span-2">
              <label htmlFor="guestName" className="block text-sm">Full name</label>
              <input id="guestName" name="guestName" required maxLength={120} autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label htmlFor="guestPhone" className="block text-sm">Phone</label>
              <input id="guestPhone" name="guestPhone" type="tel" maxLength={40} autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label htmlFor="guestEmail" className="block text-sm">Email (optional)</label>
              <input id="guestEmail" name="guestEmail" type="email" maxLength={200} autoComplete="off" className={inputClass} />
              <p className="mt-1 text-xs text-muted">A returning guest with the same email keeps one record.</p>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="source" className="block text-sm">How did they book?</label>
              <select id="source" name="source" required defaultValue="walk_in" className={inputClass}>
                {MANUAL_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </fieldset>

          <div><button type="submit" className={buttonPrimary}>Create reservation</button></div>
        </form>
      )}
    </main>
  );
}
