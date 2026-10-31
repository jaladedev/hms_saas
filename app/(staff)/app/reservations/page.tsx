import Link from "next/link";
import { buttonPrimary, buttonQuiet, inputClass, PaymentChip, ReservationChip } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import {
  listQuery, nightsBetween, PAGE_SIZE, parseFilters, SOURCE_LABEL, sortAscending, STATUS_FILTERS, statusesFor,
} from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUMNS =
  "id, property_id, booking_reference, primary_guest_id, source, reservation_status, payment_status, arrival_date, departure_date, currency, total_minor, attention_reason, created_at";

type Row = {
  id: string; property_id: string; booking_reference: string; primary_guest_id: string; source: string;
  reservation_status: string; payment_status: string; arrival_date: string; departure_date: string;
  currency: string; total_minor: number; attention_reason: string | null; created_at: string;
};

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parseFilters(await searchParams);
  const supabase = await createClient();

  let query = supabase.from("reservations").select(COLUMNS, { count: "exact" });
  const statuses = statusesFor(f.status);
  if (statuses) query = query.in("reservation_status", statuses);
  if (f.status === "attention") query = query.not("attention_reason", "is", null);
  if (f.from) query = query.gte("arrival_date", f.from);
  if (f.to) query = query.lte("arrival_date", f.to);

  if (f.q) {
    // Guest names, emails and phones need guest.view; without it RLS returns no guests and only the booking reference matches.
    const { data: found } = await supabase
      .from("guests").select("id")
      .or(`full_name.ilike.%${f.q}%,email.ilike.%${f.q}%,phone.ilike.%${f.q}%`)
      .limit(50);
    const guestIds = (found ?? []).map((g: { id: string }) => g.id);
    query = query.or([`booking_reference.ilike.%${f.q}%`, ...(guestIds.length ? [`primary_guest_id.in.(${guestIds.join(",")})`] : [])].join(","));
  }

  const asc = sortAscending(f.status);
  const offset = (f.page - 1) * PAGE_SIZE;
  const { data, error, count } = await query
    .order("arrival_date", { ascending: asc })
    .order("created_at", { ascending: asc })
    .range(offset, offset + PAGE_SIZE - 1);
  const rows = (data ?? []) as Row[];

  const resIds = rows.map((r) => r.id);
  const guestIds = [...new Set(rows.map((r) => r.primary_guest_id))];
  const propIds = [...new Set(rows.map((r) => r.property_id))];
  const [guestQ, roomQ, propQ] = await Promise.all([
    guestIds.length ? supabase.from("guests").select("id, full_name").in("id", guestIds) : { data: [] },
    resIds.length ? supabase.from("reservation_rooms").select("reservation_id, room_type_id, room_status").in("reservation_id", resIds) : { data: [] },
    propIds.length ? supabase.from("properties").select("id, name").in("id", propIds) : { data: [] },
  ]);
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));
  const roomRows = (roomQ.data ?? []) as { reservation_id: string; room_type_id: string; room_status: string }[];
  const typeIds = [...new Set(roomRows.map((r) => r.room_type_id))];
  const typeQ = typeIds.length ? await supabase.from("room_types").select("id, name").in("id", typeIds) : { data: [] };
  const typeNames = new Map(((typeQ.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const properties = new Map(((propQ.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  const showProperty = properties.size > 1;

  const roomsByRes = new Map<string, string[]>();
  for (const r of roomRows) {
    if (r.room_status === "cancelled") continue;
    roomsByRes.set(r.reservation_id, [...(roomsByRes.get(r.reservation_id) ?? []), typeNames.get(r.room_type_id) ?? "Room"]);
  }
  function roomsLabel(id: string): string {
    const names = roomsByRes.get(id) ?? [];
    if (names.length === 0) return "";
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    return [...counts].map(([n, c]) => (c > 1 ? `${c} × ${n}` : n)).join(", ");
  }

  const total = count ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const filtered = f.q !== "" || f.status !== "open" || f.from !== null || f.to !== null;

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Reservations</h1>
      <p className="mt-2 max-w-prose text-muted">Find a booking, then open it to check guests in and out, take a payment or cancel.</p>

      <form method="get" className="mt-6 grid gap-3 rounded border border-line bg-white p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
        <div>
          <label htmlFor="q" className="block text-sm">Booking reference or guest</label>
          <input id="q" name="q" defaultValue={f.q} maxLength={60} placeholder="e.g. HMS-8K2Q or Adeyemi" className={inputClass} />
        </div>
        <div>
          <label htmlFor="status" className="block text-sm">Show</label>
          <select id="status" name="status" defaultValue={f.status} className={inputClass}>
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="block text-sm">Arriving from</label>
          <input id="from" name="from" type="date" defaultValue={f.from ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm">Arriving to</label>
          <input id="to" name="to" type="date" defaultValue={f.to ?? ""} className={inputClass} />
        </div>
        <div className="flex gap-2">
          <button type="submit" className={buttonPrimary}>Search</button>
          {filtered && <Link href="/app/reservations" className={buttonQuiet}>Clear</Link>}
        </div>
      </form>

      {error && <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The reservations could not be loaded. Reload the page.</p>}

      {!error && rows.length === 0 && (
        <p className="mt-6 rounded border border-line bg-white px-4 py-6 text-muted">
          {filtered ? "No reservations match. Try a different search or clear the filters." : "There are no open reservations."}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <p className="mt-6 text-sm text-muted" aria-live="polite">
            {total} {total === 1 ? "reservation" : "reservations"}
            {pages > 1 ? `, page ${f.page} of ${pages}` : ""}
          </p>
          <ul className="mt-2 border-t border-line">
            {rows.map((r) => {
              const nights = nightsBetween(r.arrival_date, r.departure_date);
              const rooms = roomsLabel(r.id);
              return (
                <li key={r.id} className="border-b border-line">
                  <Link href={`/app/reservations/${r.id}`} className="grid gap-x-8 gap-y-2 py-4 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary md:grid-cols-[minmax(0,1fr)_11rem_9rem]">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium">{r.booking_reference}</span>
                        <ReservationChip status={r.reservation_status} />
                        <PaymentChip status={r.payment_status} />
                        {r.attention_reason && <span className="rounded bg-critical/10 px-2 py-0.5 text-xs font-medium text-critical">Needs attention</span>}
                      </div>
                      <p className="mt-1 text-sm">{guests.get(r.primary_guest_id) ?? <span className="text-muted">Guest not visible to you</span>}</p>
                      <p className="mt-1 text-xs text-muted">
                        {[rooms, SOURCE_LABEL[r.source] ?? r.source, showProperty ? properties.get(r.property_id) : null].filter(Boolean).join(", ")}
                      </p>
                    </div>
                    <p className="text-sm md:text-right">
                      {formatDate(r.arrival_date)}
                      <span className="block text-xs text-muted">{nights} {nights === 1 ? "night" : "nights"}, to {formatDate(r.departure_date)}</span>
                    </p>
                    <p className="font-semibold tabular-nums md:text-right">{formatMoney(r.total_minor, r.currency)}</p>
                  </Link>
                </li>
              );
            })}
          </ul>

          {pages > 1 && (
            <nav aria-label="Pages" className="mt-6 flex items-center justify-between text-sm">
              {f.page > 1
                ? <Link href={`/app/reservations${listQuery(f, { page: f.page - 1 })}`} className={buttonQuiet} rel="prev">Previous</Link>
                : <span />}
              <span className="text-muted">Page {f.page} of {pages}</span>
              {f.page < pages
                ? <Link href={`/app/reservations${listQuery(f, { page: f.page + 1 })}`} className={buttonQuiet} rel="next">Next</Link>
                : <span />}
            </nav>
          )}
        </>
      )}
    </main>
  );
}
