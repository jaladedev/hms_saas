import Link from "next/link";
import { PrintButton } from "@/components/staff/print-button";
import { ErrorBanner, PageIntro, PageTitle, linkClass } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { loadDeskRows } from "@/lib/staff/desk-query";
import { buildSheet, currentRoomId, type SheetClaim, type SheetRoom } from "@/lib/staff/desk-sheet";
import { bucketFrontDesk } from "@/lib/staff/front-desk";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CHUNK = 100;

/** Runs a lookup `in (...)` a hundred ids at a time, so a full house never makes the address too long. */
async function inChunks(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>) {
  const parts = [];
  for (let i = 0; i < ids.length; i += CHUNK) parts.push(ids.slice(i, i + CHUNK));
  const results = await Promise.all(parts.map((p) => run(p)));
  return {
    rows: results.flatMap((r) => (Array.isArray(r.data) ? (r.data as unknown[]) : [])),
    failed: results.some((r) => Boolean(r.error)),
  };
}

const timeIn = (timeZone: string, now: Date) => {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(now);
  try {
    return fmt(timeZone);
  } catch {
    return fmt("UTC");
  }
};

/**
 * The front desk on one sheet of paper: who arrives, who is in the hotel, who leaves, in which room, and whether they have paid.
 * It is the paper fallback for when the screen or the connection is gone, so it is a plain page that prints well, and the service
 * worker keeps a copy of it like the other front desk pages. It shows no prices, phone numbers or ID details.
 */
export default async function FrontDeskSheetPage() {
  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name, timezone");
  const properties = (props ?? []) as { id: string; name: string; timezone: string }[];
  const now = new Date();
  const todayByProperty = new Map(properties.map((p) => [p.id, todayIn(p.timezone, now)]));
  const dates = [...todayByProperty.values()].sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];
  const showProperty = properties.length > 1;
  const propName = new Map(properties.map((p) => [p.id, p.name]));

  let loadError = Boolean(propError);
  let rows: Awaited<ReturnType<typeof loadDeskRows>>["rows"] = [];
  if (earliest && latest) {
    const loaded = await loadDeskRows(supabase, earliest, latest);
    loadError = loadError || Boolean(loaded.error);
    rows = loaded.rows;
  }
  const groups = bucketFrontDesk(rows, todayByProperty);
  // Only what is on the sheet needs looking up.
  const listed = new Map(
    [...groups.arrivals, ...groups.departures, ...groups.inHouse, ...groups.overdue, ...groups.lateArrivals].map((r) => [r.id, r]),
  );

  // bucketFrontDesk hands back plain desk rows, so the guest of each booking is read from the rows that were loaded.
  const guestOfRes = new Map(rows.map((r) => [r.id, r.primary_guest_id]));
  const guestLookup = await inChunks([...new Set([...listed.keys()].map((id) => guestOfRes.get(id) ?? ""))].filter(Boolean), (ids) =>
    supabase.from("guests").select("id, full_name").in("id", ids),
  );
  // Guest names need guest.view; without it a row shows the booking reference alone, as on the screen.
  const guests = new Map((guestLookup.rows as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));

  const roomLookup = await inChunks([...listed.keys()], (ids) =>
    supabase.from("reservation_rooms").select("id, reservation_id, adults, children, room_status").in("reservation_id", ids),
  );
  const resRooms = (
    roomLookup.rows as { id: string; reservation_id: string; adults: number; children: number; room_status: string }[]
  ).filter((r) => r.room_status !== "cancelled");
  const claimLookup = await inChunks(
    resRooms.map((r) => r.id),
    (ids) =>
      supabase
        .from("room_inventory_claims")
        .select("reservation_room_id, room_id, start_date, end_date")
        .in("reservation_room_id", ids)
        .eq("status", "active")
        .eq("claim_type", "stay"),
  );
  const claimsByRr = new Map<string, SheetClaim[]>();
  for (const c of claimLookup.rows as (SheetClaim & { reservation_room_id: string })[]) {
    claimsByRr.set(c.reservation_room_id, [...(claimsByRr.get(c.reservation_room_id) ?? []), c]);
  }
  const numberLookup = await inChunks([...new Set([...claimsByRr.values()].flat().map((c) => c.room_id))], (ids) =>
    supabase.from("rooms").select("id, room_number").in("id", ids),
  );
  const numbers = new Map((numberLookup.rows as { id: string; room_number: string }[]).map((r) => [r.id, r.room_number]));

  const sheetRooms: SheetRoom[] = resRooms.map((rr) => {
    const res = listed.get(rr.reservation_id);
    const today = (res && todayByProperty.get(res.property_id)) ?? earliest ?? "";
    const roomId = currentRoomId(claimsByRr.get(rr.id) ?? [], today);
    return {
      reservationId: rr.reservation_id,
      roomNumber: roomId ? (numbers.get(roomId) ?? null) : null,
      adults: rr.adults,
      children: rr.children,
    };
  });
  const roomsFailed = roomLookup.failed || claimLookup.failed || numberLookup.failed;

  const sections = buildSheet({ groups, guestOf: (r) => guests.get(guestOfRes.get(r.id) ?? "") ?? "", rooms: sheetRooms });
  const firstZone = properties[0]?.timezone ?? "UTC";
  const hotel = properties.map((p) => p.name).join(", ");

  return (
    <main className="max-w-5xl print:max-w-none">
      <PageTitle>Front desk sheet</PageTitle>
      <p className="mt-1 text-sm">
        {hotel && <>{hotel}. </>}
        {earliest ? formatDate(earliest) : ""}, prepared {timeIn(firstZone, now)}.
      </p>
      <PageIntro>
        Arrivals, guests in house and departures with their rooms and payment state, to print and keep at the desk. It shows no prices or
        contact details.
      </PageIntro>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm print:hidden">
        <PrintButton />
        <Link href="/app/front-desk" className={linkClass}>
          Back to the front desk
        </Link>
      </p>

      {loadError && <ErrorBanner className="mt-6">The front desk list could not be loaded. Reload the page before printing.</ErrorBanner>}
      {!loadError && roomsFailed && (
        <ErrorBanner className="mt-6">
          Some room numbers could not be loaded and show as not assigned. Reload the page before printing.
        </ErrorBanner>
      )}

      <div className="mt-6 space-y-8 print:mt-3 print:space-y-5">
        {sections.map((s) =>
          s.key === "problems" && s.rows.length === 0 ? null : (
            <section key={s.key} aria-labelledby={`sheet-${s.key}`}>
              <h2 id={`sheet-${s.key}`} className="font-display text-xl print:text-base">
                {s.title} <span className="text-base text-muted print:text-sm">({s.rows.length})</span>
              </h2>
              {s.hint && s.rows.length > 0 && <p className="mt-1 text-sm text-muted">{s.hint}</p>}
              {s.rows.length === 0 ? (
                <p className="mt-2 text-sm text-muted">None.</p>
              ) : (
                <div className="mt-2 overflow-x-auto print:overflow-visible">
                  <table className="w-full min-w-[44rem] border-collapse text-sm print:min-w-0 print:text-xs">
                    <thead>
                      <tr className="border-b-2 border-ink text-left">
                        <th scope="col" className="w-20 py-1 pr-3 font-medium">
                          Room
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          Guest
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          Stay
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          People
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          Payment
                        </th>
                        <th scope="col" className="w-1/4 py-1 font-medium">
                          Notes
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.map((r) => (
                        <tr key={`${s.key}-${r.id}`} className="h-10 border-b border-line align-top print:h-9">
                          <td className="py-1.5 pr-3 font-medium">{r.rooms}</td>
                          <td className="py-1.5 pr-3">
                            <span className="block">{r.guest || r.reference}</span>
                            <span className="block text-xs text-muted">
                              {r.guest ? r.reference : ""}
                              {showProperty ? `${r.guest ? ", " : ""}${propName.get(r.propertyId) ?? ""}` : ""}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3">
                            {formatDate(r.arrival)} to {formatDate(r.departure)}
                            <span className="block text-xs text-muted">
                              {r.nights} {r.nights === 1 ? "night" : "nights"}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3">{r.people || "-"}</td>
                          <td className="py-1.5 pr-3">
                            {r.payment}
                            {r.attention && <span className="block text-xs font-medium text-critical">Needs attention</span>}
                          </td>
                          <td className="py-1.5" />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ),
        )}
      </div>
    </main>
  );
}
