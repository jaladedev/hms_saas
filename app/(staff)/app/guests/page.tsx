import Link from "next/link";
import { inputClass, buttonPrimary, ErrorBanner, EmptyState, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { bookedLine, searchPattern, stayLine, summariseStays, vipOnly, type StayRow } from "@/lib/staff/guests";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;
const STAY_ROW_CAP = 2000;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function GuestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const q = (one(search.q) ?? "").slice(0, 80);
  const pattern = searchPattern(q);
  const vip = vipOnly(search.vip);
  const supabase = await createClient();

  let query = supabase
    .from("guests")
    .select("id, full_name, email, phone, vip")
    .order("full_name")
    .limit(PAGE_SIZE + 1);
  if (vip) query = query.eq("vip", true);
  if (pattern) query = query.or(`full_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`);
  const [guestQ, propQ] = await Promise.all([query, supabase.from("properties").select("timezone")]);
  const all = (guestQ.data ?? []) as { id: string; full_name: string; email: string | null; phone: string | null; vip: boolean }[];
  const guests = all.slice(0, PAGE_SIZE);
  const more = all.length > PAGE_SIZE;

  const now = new Date();
  const today = ((propQ.data ?? []) as { timezone: string }[]).map((p) => todayIn(p.timezone, now)).sort()[0] ?? todayIn("UTC", now);
  const stayQ = guests.length
    ? await supabase
        .from("reservations")
        .select("primary_guest_id, reservation_status, arrival_date, departure_date, total_minor, currency")
        .in(
          "primary_guest_id",
          guests.map((g) => g.id),
        )
        .limit(STAY_ROW_CAP)
    : { data: [], error: null };
  const stayRows = (stayQ.data ?? []) as StayRow[];
  const stays = summariseStays(stayRows, today);
  // The query is capped. If it hit the cap, some stays are missing, so a booked total could be too low: show none rather than a wrong one.
  const totalsComplete = stayRows.length < STAY_ROW_CAP;

  return (
    <main className="max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Guests</PageTitle>
          <PageIntro>Everyone who has booked with the hotel. Search by name, email or phone.</PageIntro>
        </div>
        <Link href="/app/guests/new" className={buttonPrimary}>
          Add a guest
        </Link>
      </div>

      <form method="get" className="mt-6 flex max-w-xl items-center gap-2" role="search">
        <label htmlFor="q" className="sr-only">
          Search guests
        </label>
        <input id="q" name="q" defaultValue={q} placeholder="Name, email or phone" autoComplete="off" className={inputClass} />
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input type="checkbox" name="vip" value="1" defaultChecked={vip} />
          VIP only
        </label>
        <PendingButton className={buttonPrimary} pendingLabel="Searching…">
          Search
        </PendingButton>
      </form>

      {guestQ.error && <ErrorBanner className="mt-6">The guest list could not be loaded. Reload the page.</ErrorBanner>}
      {q && !pattern && <p className="mt-4 text-sm text-muted">Type at least two letters or digits.</p>}

      {!guestQ.error && guests.length === 0 ? (
        <EmptyState className="mt-6">
          {pattern || vip ? "No guest matches that." : "No guests yet, or your role cannot see guest details."}
        </EmptyState>
      ) : (
        <ul className="mt-6 border-t border-line">
          {guests.map((g) => (
            <li key={g.id} className="border-b border-line">
              <Link
                href={`/app/guests/${g.id}`}
                className="grid gap-x-6 gap-y-1 py-3 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]"
              >
                <span className="min-w-0">
                  <span className="font-medium">{g.full_name}</span>
                  {g.vip && <span className="ml-2 rounded bg-pending/10 px-2 py-0.5 text-xs font-medium text-pending">VIP</span>}
                  <span className="block truncate text-sm text-muted">
                    {[g.email, g.phone].filter(Boolean).join(", ") || "No contact details"}
                  </span>
                </span>
                <span className="text-sm text-muted md:text-right">
                  {stayLine(stays.get(g.id), formatDate)}
                  {totalsComplete && bookedLine(stays.get(g.id), formatMoney) && (
                    <span className="block text-xs">{bookedLine(stays.get(g.id), formatMoney)}</span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more && <p className="mt-3 text-sm text-muted">Showing the first {PAGE_SIZE}. Narrow the search to see others.</p>}
    </main>
  );
}
