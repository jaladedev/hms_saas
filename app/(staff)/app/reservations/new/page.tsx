import Link from "next/link";
import { buttonPrimary, inputClass, Notice, linkClass, EmptyState, PageIntro, PageTitle } from "@/components/staff/ui";
import { createManualReservation } from "@/lib/staff/reservation-actions";
import { MANUAL_SOURCES, MAX_NIGHTS, MAX_ROOMS, parsePrefill } from "@/lib/staff/new-reservation";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

export default async function NewReservationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, typeQ, roomQ] = await Promise.all([
    supabase.from("properties").select("id, name, timezone").eq("status", "active").order("name"),
    supabase.from("room_types").select("id, property_id, name, max_adults, max_children").eq("status", "active").order("name"),
    supabase.from("rooms").select("id, room_type_id, room_number").eq("operational_status", "active").order("room_number"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const types = (typeQ.data ?? []) as { id: string; property_id: string; name: string; max_adults: number; max_children: number }[];
  const rooms = (roomQ.data ?? []) as { id: string; room_type_id: string; room_number: string }[];
  // Only properties where the viewer may create bookings (the database checks again on submit).
  const allowed = (
    await Promise.all(
      properties.map(async (p) => {
        const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "reservation.create" });
        return data === true ? p : null;
      }),
    )
  ).filter((p): p is (typeof properties)[number] => p !== null);
  const today = todayIn(allowed[0]?.timezone ?? "UTC", new Date());
  const many = allowed.length > 1;
  // With no room chosen from the calendar, the property picked in the header is the one the form starts on.
  const preferred = many ? pickProperty(allowed, undefined, await rememberedProperty()) : undefined;
  // Starting values from the room calendar (?room=&arrival=&departure=). A hint only: see parsePrefill.
  const typeProperty = new Map(types.map((t) => [t.id, t.property_id]));
  const prefill = parsePrefill(
    search,
    today,
    rooms.flatMap((r) => {
      const property_id = typeProperty.get(r.room_type_id);
      return property_id ? [{ id: r.id, room_type_id: r.room_type_id, property_id }] : [];
    }),
    allowed.map((p) => p.id),
  );

  return (
    <main className="max-w-2xl">
      <p className="text-sm">
        <Link href="/app/reservations" className={linkClass}>
          Reservations
        </Link>
      </p>
      <PageTitle className="mt-2">New reservation</PageTitle>
      <PageIntro>
        For guests who walk in or book by phone. The rooms are held and the booking is confirmed straight away, or you can hold the room
        until the guest pays.
      </PageIntro>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>

      {allowed.length === 0 ? (
        <EmptyState>You do not have permission to create reservations, or no property is set up yet.</EmptyState>
      ) : (
        <form action={createManualReservation} className="mt-6 grid gap-5">
          <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
          {!many && <input type="hidden" name="propertyId" value={allowed[0]!.id} />}

          <fieldset className="grid gap-4 rounded border border-line bg-white p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Stay</legend>
            {many && (
              <div className="sm:col-span-2">
                <label htmlFor="propertyId" className="block text-sm">
                  Property
                </label>
                <select
                  id="propertyId"
                  name="propertyId"
                  required
                  defaultValue={prefill.propertyId ?? preferred?.id ?? ""}
                  className={inputClass}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {allowed.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="arrival" className="block text-sm">
                Arrival
              </label>
              <input id="arrival" name="arrival" type="date" required min={today} defaultValue={prefill.arrival} className={inputClass} />
            </div>
            <div>
              <label htmlFor="departure" className="block text-sm">
                Departure
              </label>
              <input
                id="departure"
                name="departure"
                type="date"
                required
                min={today}
                defaultValue={prefill.departure ?? undefined}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted">Up to {MAX_NIGHTS} nights. The guest leaves on this day.</p>
            </div>
          </fieldset>

          <fieldset className="grid gap-4 rounded border border-line bg-white p-4">
            <legend className="px-1 text-sm font-medium">Rooms</legend>
            <p className="text-xs text-muted">
              Book up to {MAX_ROOMS} rooms together. Leave the extra rows empty for a single room. If any room is unavailable, none are
              booked.
            </p>
            {Array.from({ length: MAX_ROOMS }, (_, n) => n + 1).map((i) => {
              const sfx = i === 1 ? "" : `_${i}`;
              return (
                <div key={i} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem_6rem]">
                  <div>
                    <label htmlFor={`roomTypeId${sfx}`} className="block text-sm">
                      Room {i}
                      {i > 1 ? " (optional)" : ""}
                    </label>
                    <select
                      id={`roomTypeId${sfx}`}
                      name={`roomTypeId${sfx}`}
                      required={i === 1}
                      defaultValue={i === 1 ? (prefill.roomTypeId ?? "") : ""}
                      className={inputClass}
                    >
                      <option value="">{i === 1 ? "Choose…" : "None"}</option>
                      {allowed.map((p) => (
                        <optgroup key={p.id} label={many ? p.name : "Room types"}>
                          {types
                            .filter((t) => t.property_id === p.id)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name} (up to {t.max_adults} adults{t.max_children > 0 ? `, ${t.max_children} children` : ""})
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-3">
                    <label htmlFor={`roomId${sfx}`} className="block text-sm">
                      Which room? (optional)
                    </label>
                    <select
                      id={`roomId${sfx}`}
                      name={`roomId${sfx}`}
                      defaultValue={i === 1 ? (prefill.roomId ?? "") : ""}
                      className={inputClass}
                    >
                      <option value="">Any free room of that type</option>
                      {allowed.flatMap((p) =>
                        types
                          .filter((t) => t.property_id === p.id)
                          .map((t) => (
                            <optgroup key={t.id} label={many ? `${p.name}: ${t.name}` : t.name}>
                              {rooms
                                .filter((r) => r.room_type_id === t.id)
                                .map((r) => (
                                  <option key={r.id} value={r.id}>
                                    Room {r.room_number}
                                  </option>
                                ))}
                            </optgroup>
                          )),
                      )}
                    </select>
                    <p className="mt-1 text-xs text-muted">
                      Pick a room only if the guest asked for it; it must be a room of the type chosen above.
                    </p>
                  </div>
                  <div>
                    <label htmlFor={`adults${sfx}`} className="block text-sm">
                      Adults
                    </label>
                    <input
                      id={`adults${sfx}`}
                      name={`adults${sfx}`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={20}
                      defaultValue={i === 1 ? 1 : ""}
                      placeholder="1"
                      required={i === 1}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor={`children${sfx}`} className="block text-sm">
                      Children
                    </label>
                    <input
                      id={`children${sfx}`}
                      name={`children${sfx}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={20}
                      defaultValue={i === 1 ? 0 : ""}
                      placeholder="0"
                      className={inputClass}
                    />
                  </div>
                </div>
              );
            })}
          </fieldset>

          <fieldset className="grid gap-4 rounded border border-line bg-white p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Guest</legend>
            <div className="sm:col-span-2">
              <label htmlFor="guestName" className="block text-sm">
                Full name
              </label>
              <input id="guestName" name="guestName" required maxLength={120} autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label htmlFor="guestPhone" className="block text-sm">
                Phone
              </label>
              <input id="guestPhone" name="guestPhone" type="tel" maxLength={40} autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label htmlFor="guestEmail" className="block text-sm">
                Email (optional)
              </label>
              <input id="guestEmail" name="guestEmail" type="email" maxLength={200} autoComplete="off" className={inputClass} />
              <p className="mt-1 text-xs text-muted">A returning guest with the same email keeps one record.</p>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="source" className="block text-sm">
                How did they book?
              </label>
              <select id="source" name="source" required defaultValue="walk_in" className={inputClass}>
                {MANUAL_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <label className="flex max-w-xl items-start gap-2 rounded border border-line bg-white p-4 text-sm">
            <input type="checkbox" name="holdUntilPaid" className="mt-1" />
            <span>
              Hold the room until the guest pays
              <span className="mt-1 block text-xs text-muted">
                The booking stays pending and the room is held for the hotel&rsquo;s hold time (20 minutes unless the policy says
                otherwise). Record the payment on the booking to confirm it; if time runs out first, the room is released.
              </span>
            </span>
          </label>

          <div>
            <PendingButton className={buttonPrimary} pendingLabel="Creating…">
              Create reservation
            </PendingButton>
          </div>
        </form>
      )}
    </main>
  );
}
