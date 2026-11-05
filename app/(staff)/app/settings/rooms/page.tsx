import { buttonPrimary, buttonQuiet, inputClass, Notice, ErrorBanner, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { ROOM_STATUSES } from "@/lib/staff/room-setup";
import { compareRoomNumbers } from "@/lib/staff/room-board";
import { addRoom, addRoomType, setRoomStatus, setRoomTypeStatus, updateRoomType } from "@/lib/staff/setup-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RoomType = {
  id: string; property_id: string; name: string; code: string; description: string | null; max_adults: number; max_children: number;
  max_occupancy: number; base_rate_minor: number; currency: string; is_public: boolean; status: string;
};
type Room = { id: string; property_id: string; room_type_id: string; room_number: string; floor: number | null; operational_status: string };

export default async function RoomSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, typeQ, roomQ] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase.from("room_types").select("id, property_id, name, code, description, max_adults, max_children, max_occupancy, base_rate_minor, currency, is_public, status").order("name"),
    supabase.from("rooms").select("id, property_id, room_type_id, room_number, floor, operational_status").limit(2000),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const types = (typeQ.data ?? []) as RoomType[];
  const rooms = (roomQ.data ?? []) as Room[];
  const loadError = Boolean(propQ.error || typeQ.error || roomQ.error);

  // Only properties where the viewer may change the setup; the tables enforce the same rule on every write.
  const editable = (await Promise.all(properties.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "property.configure" });
    return data === true ? p : null;
  }))).filter((p): p is (typeof properties)[number] => p !== null);
  const many = properties.length > 1;

  return (
    <main className="max-w-4xl">
      <PageTitle>Room types and rooms</PageTitle>
      <PageIntro>
        A room type is a kind of room you sell, with its capacity and standard price. Rooms are the actual doors. Guests book a type; the system picks a free room of that type.
      </PageIntro>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <ErrorBanner className="mb-6">The setup could not be loaded. Reload the page.</ErrorBanner>}
      {editable.length === 0 && !loadError && (
        <p className="mb-6 rounded border border-line bg-white px-4 py-3 text-sm text-muted">You can look at the setup but not change it. Changes need hotel-setup permission.</p>
      )}

      {properties.map((p) => {
        const myTypes = types.filter((t) => t.property_id === p.id);
        const canEdit = editable.some((e) => e.id === p.id);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {myTypes.length === 0 && <p className="mt-3 text-muted">No room types yet.{canEdit ? " Add the first one below." : ""}</p>}

            {myTypes.map((t) => {
              const mine = rooms.filter((r) => r.room_type_id === t.id).sort((a, b) => compareRoomNumbers(a.room_number, b.room_number));
              return (
                <div key={t.id} className="mt-5 rounded border border-line bg-white p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h3 className="text-lg font-semibold">{t.name} <span className="text-sm font-normal text-muted">{t.code}</span></h3>
                    <p className="tabular-nums">{formatMoney(t.base_rate_minor, t.currency)} <span className="text-sm text-muted">a night</span></p>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    Up to {t.max_adults} {t.max_adults === 1 ? "adult" : "adults"}{t.max_children > 0 ? `, ${t.max_children} ${t.max_children === 1 ? "child" : "children"}` : ""}, {t.max_occupancy} in all.
                    {" "}{t.is_public ? "Bookable online." : "Staff only."}{t.status !== "active" ? " Inactive." : ""}
                  </p>
                  {t.description && <p className="mt-1 max-w-prose text-sm">{t.description}</p>}

                  {canEdit && (
                    <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-2">
                      <details className="min-w-0 flex-1">
                        <summary className="cursor-pointer text-sm font-medium text-primary-strong">Edit {t.name}</summary>
                        <form action={updateRoomType} className="mt-3 grid gap-4 sm:grid-cols-2">
                          <input type="hidden" name="roomTypeId" value={t.id} />
                          <div>
                            <label htmlFor={`en-${t.id}`} className="block text-sm">Name</label>
                            <input id={`en-${t.id}`} name="name" required maxLength={80} defaultValue={t.name} className={inputClass} />
                          </div>
                          <div>
                            <label htmlFor={`er-${t.id}`} className="block text-sm">Standard price a night (₦)</label>
                            <input id={`er-${t.id}`} name="baseRate" inputMode="decimal" required defaultValue={(t.base_rate_minor / 100).toFixed(2)} className={`${inputClass} tabular-nums`} />
                            <p className="mt-1 text-xs text-muted">Applies to new bookings only. Nights with their own price on the Rates page keep it.</p>
                          </div>
                          <div>
                            <label htmlFor={`ea-${t.id}`} className="block text-sm">Most adults</label>
                            <input id={`ea-${t.id}`} name="maxAdults" type="number" inputMode="numeric" min={1} max={20} required defaultValue={t.max_adults} className={inputClass} />
                          </div>
                          <div>
                            <label htmlFor={`ek-${t.id}`} className="block text-sm">Most children</label>
                            <input id={`ek-${t.id}`} name="maxChildren" type="number" inputMode="numeric" min={0} max={20} defaultValue={t.max_children} className={inputClass} />
                          </div>
                          <div>
                            <label htmlFor={`eo-${t.id}`} className="block text-sm">Most people in all</label>
                            <input id={`eo-${t.id}`} name="maxOccupancy" type="number" inputMode="numeric" min={1} max={40} defaultValue={t.max_occupancy} className={inputClass} />
                          </div>
                          <div className="sm:col-span-2">
                            <label htmlFor={`ed-${t.id}`} className="block text-sm">Description (optional)</label>
                            <textarea id={`ed-${t.id}`} name="description" maxLength={500} rows={2} defaultValue={t.description ?? ""} className={inputClass} />
                          </div>
                          <div className="flex items-center gap-2 sm:col-span-2">
                            <input id={`ep-${t.id}`} name="isPublic" type="checkbox" defaultChecked={t.is_public} className="h-4 w-4" />
                            <label htmlFor={`ep-${t.id}`} className="text-sm">Guests can book this type on the hotel&apos;s website</label>
                          </div>
                          <div className="sm:col-span-2"><button type="submit" className={buttonPrimary}>Save changes</button></div>
                        </form>
                      </details>
                      <form action={setRoomTypeStatus}>
                        <input type="hidden" name="roomTypeId" value={t.id} />
                        <input type="hidden" name="status" value={t.status === "active" ? "inactive" : "active"} />
                        <button type="submit" className={buttonQuiet}>{t.status === "active" ? "Switch off" : "Switch on"}</button>
                      </form>
                    </div>
                  )}

                  <h4 className="mt-4 text-sm font-medium">Rooms ({mine.length})</h4>
                  {mine.length === 0 ? <p className="mt-1 text-sm text-muted">No rooms yet, so this type cannot be booked.</p> : (
                    <ul className="mt-2 divide-y divide-line border-y border-line">
                      {mine.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
                          <span><span className="font-medium">{r.room_number}</span>{r.floor !== null && <span className="ml-3 text-sm text-muted">Floor {r.floor}</span>}</span>
                          {canEdit ? (
                            <form action={setRoomStatus} className="flex items-center gap-2">
                              <input type="hidden" name="roomId" value={r.id} />
                              <label htmlFor={`st-${r.id}`} className="sr-only">Status of room {r.room_number}</label>
                              <select id={`st-${r.id}`} name="status" defaultValue={r.operational_status} className={`${inputClass} w-auto`}>
                                {ROOM_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                              </select>
                              <button type="submit" className={buttonQuiet}>Save</button>
                            </form>
                          ) : <span className="text-sm text-muted">{ROOM_STATUSES.find((s) => s.value === r.operational_status)?.label}</span>}
                        </li>
                      ))}
                    </ul>
                  )}

                  {canEdit && (
                    <form action={addRoom} className="mt-3 flex flex-wrap items-end gap-3">
                      <input type="hidden" name="roomTypeId" value={t.id} />
                      <div>
                        <label htmlFor={`rn-${t.id}`} className="block text-sm">Room number</label>
                        <input id={`rn-${t.id}`} name="roomNumber" required maxLength={10} className={`${inputClass} w-28`} />
                      </div>
                      <div>
                        <label htmlFor={`fl-${t.id}`} className="block text-sm">Floor (optional)</label>
                        <input id={`fl-${t.id}`} name="floor" inputMode="numeric" className={`${inputClass} w-24`} />
                      </div>
                      <button type="submit" className={buttonQuiet}>Add room</button>
                    </form>
                  )}
                </div>
              );
            })}

            {canEdit && (
              <details className="mt-6 rounded border border-line bg-white p-4">
                <summary className="cursor-pointer font-medium text-primary-strong">Add a room type{many ? ` to ${p.name}` : ""}</summary>
                <form action={addRoomType} className="mt-4 grid gap-4 sm:grid-cols-2">
                  <input type="hidden" name="propertyId" value={p.id} />
                  <div>
                    <label htmlFor={`n-${p.id}`} className="block text-sm">Name</label>
                    <input id={`n-${p.id}`} name="name" required maxLength={80} placeholder="Deluxe Double" className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor={`c-${p.id}`} className="block text-sm">Short code</label>
                    <input id={`c-${p.id}`} name="code" required maxLength={12} placeholder="DLX" className={`${inputClass} uppercase`} />
                    <p className="mt-1 text-xs text-muted">Letters, numbers and hyphens, unique at this hotel.</p>
                  </div>
                  <div>
                    <label htmlFor={`a-${p.id}`} className="block text-sm">Most adults</label>
                    <input id={`a-${p.id}`} name="maxAdults" type="number" inputMode="numeric" min={1} max={20} required defaultValue={2} className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor={`k-${p.id}`} className="block text-sm">Most children</label>
                    <input id={`k-${p.id}`} name="maxChildren" type="number" inputMode="numeric" min={0} max={20} defaultValue={0} className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor={`o-${p.id}`} className="block text-sm">Most people in all (optional)</label>
                    <input id={`o-${p.id}`} name="maxOccupancy" type="number" inputMode="numeric" min={1} max={40} className={inputClass} />
                    <p className="mt-1 text-xs text-muted">Leave empty to allow adults plus children.</p>
                  </div>
                  <div>
                    <label htmlFor={`r-${p.id}`} className="block text-sm">Standard price a night (₦)</label>
                    <input id={`r-${p.id}`} name="baseRate" inputMode="decimal" required placeholder="45,000" className={`${inputClass} tabular-nums`} />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor={`d-${p.id}`} className="block text-sm">Description (optional)</label>
                    <textarea id={`d-${p.id}`} name="description" maxLength={500} rows={2} className={inputClass} />
                  </div>
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <input id={`p-${p.id}`} name="isPublic" type="checkbox" defaultChecked className="h-4 w-4" />
                    <label htmlFor={`p-${p.id}`} className="text-sm">Guests can book this type on the hotel's website</label>
                  </div>
                  <div className="sm:col-span-2"><button type="submit" className={buttonPrimary}>Add room type</button></div>
                </form>
              </details>
            )}
          </section>
        );
      })}
    </main>
  );
}
