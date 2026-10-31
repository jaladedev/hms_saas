import Link from "next/link";
import { inputClass, buttonPrimary } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { searchPattern, stayLine, summariseStays, type StayRow } from "@/lib/staff/guests";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function GuestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const q = (one(search.q) ?? "").slice(0, 80);
  const pattern = searchPattern(q);
  const supabase = await createClient();

  let query = supabase.from("guests").select("id, full_name, email, phone").order("full_name").limit(PAGE_SIZE + 1);
  if (pattern) query = query.or(`full_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`);
  const [guestQ, propQ] = await Promise.all([query, supabase.from("properties").select("timezone")]);
  const all = (guestQ.data ?? []) as { id: string; full_name: string; email: string | null; phone: string | null }[];
  const guests = all.slice(0, PAGE_SIZE);
  const more = all.length > PAGE_SIZE;

  const now = new Date();
  const today = ((propQ.data ?? []) as { timezone: string }[]).map((p) => todayIn(p.timezone, now)).sort()[0] ?? todayIn("UTC", now);
  const stayQ = guests.length
    ? await supabase.from("reservations").select("primary_guest_id, reservation_status, arrival_date, departure_date").in("primary_guest_id", guests.map((g) => g.id)).limit(2000)
    : { data: [], error: null };
  const stays = summariseStays((stayQ.data ?? []) as StayRow[], today);

  return (
    <main className="max-w-4xl">
      <h1 className="font-display text-3xl">Guests</h1>
      <p className="mt-2 max-w-prose text-muted">Everyone who has booked with the hotel. Search by name, email or phone.</p>

      <form method="get" className="mt-6 flex max-w-xl gap-2" role="search">
        <label htmlFor="q" className="sr-only">Search guests</label>
        <input id="q" name="q" defaultValue={q} placeholder="Name, email or phone" autoComplete="off" className={inputClass} />
        <button type="submit" className={buttonPrimary}>Search</button>
      </form>

      {guestQ.error && <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The guest list could not be loaded. Reload the page.</p>}
      {q && !pattern && <p className="mt-4 text-sm text-muted">Type at least two letters or digits.</p>}

      {!guestQ.error && guests.length === 0 ? (
        <p className="mt-6 rounded border border-line bg-white px-4 py-6 text-muted">
          {pattern ? "No guest matches that." : "No guests yet, or your role cannot see guest details."}
        </p>
      ) : (
        <ul className="mt-6 border-t border-line">
          {guests.map((g) => (
            <li key={g.id} className="border-b border-line">
              <Link href={`/app/guests/${g.id}`} className="grid gap-x-6 gap-y-1 py-3 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
                <span className="min-w-0">
                  <span className="font-medium">{g.full_name}</span>
                  <span className="block truncate text-sm text-muted">{[g.email, g.phone].filter(Boolean).join(", ") || "No contact details"}</span>
                </span>
                <span className="text-sm text-muted md:text-right">{stayLine(stays.get(g.id), formatDate)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more && <p className="mt-3 text-sm text-muted">Showing the first {PAGE_SIZE}. Narrow the search to see others.</p>}
    </main>
  );
}
