import Link from "next/link";
import { PrintButton } from "@/components/staff/print-button";
import { PrintHeader } from "@/components/staff/print-header";
import {
  buttonPrimary,
  inputClass,
  linkClass,
  EmptyState,
  PageIntro,
  StatTile,
  tdNum,
  thNum,
  headRow,
  thRowHead,
  totalRow,
  PageTitle,
} from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { countryLabel, lostBp, shareBp, sourceLabel, type ChannelReport, type GuestReport } from "@/lib/staff/channels";
import { chargedMinor, chargeLabel, isCut, type NoShowList } from "@/lib/staff/no-shows";
import { formatBp } from "@/lib/staff/occupancy";
import { MAX_RANGE_DAYS, parseRange, presets } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function ChannelsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props } = await supabase.from("properties").select("id, name, timezone").eq("status", "active").order("name");
  const all = (props ?? []) as { id: string; name: string; timezone: string }[];
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "report.view" });
        return data === true ? p : null;
      }),
    )
  ).filter((p): p is (typeof all)[number] => p !== null);

  if (allowed.length === 0) {
    return (
      <main className="max-w-2xl">
        <PageTitle>Channels and guests</PageTitle>
        <EmptyState className="mt-4">You do not have permission to see reports.</EmptyState>
      </main>
    );
  }

  const chosen = pickProperty(allowed, typeof search.property === "string" ? search.property : undefined, await rememberedProperty())!;
  const today = todayIn(chosen.timezone, new Date());
  const range = parseRange(search.from, search.to, today);
  const args = { p_property_id: chosen.id, p_from: range.from, p_to: range.to };
  const [chQ, guQ, nsQ, exportQ] = await Promise.all([
    supabase.rpc("channel_report", args),
    supabase.rpc("guest_report", args),
    supabase.rpc("no_show_list", args),
    supabase.rpc("has_permission", { p_property: chosen.id, p_permission: "report.export" }),
  ]);
  const channels = chQ.error ? null : (chQ.data as ChannelReport);
  const guests = guQ.error ? null : (guQ.data as GuestReport);
  const noShows = nsQ.error ? null : (nsQ.data as NoShowList);
  const currency = channels?.currency ?? guests?.currency ?? "NGN";
  const money = (n: number) => formatMoney(n, currency);
  const qs = (from: string, to: string) => `?${new URLSearchParams({ property: chosen.id, from, to })}`;
  const csv = (kind: string) =>
    `/app/reports/channels/csv?${new URLSearchParams({ property: chosen.id, from: range.from, to: range.to, kind })}`;
  const mayExport = exportQ.data === true;

  return (
    <main>
      <p className="text-sm print:hidden">
        <Link href="/app/reports" className={linkClass}>
          Money and revenue report
        </Link>
        <span aria-hidden="true"> · </span>
        <Link href={`/app/reports/occupancy${qs(range.from, range.to)}`} className={linkClass}>
          Occupancy
        </Link>
      </p>
      <PageTitle className="mt-2">Channels and guests</PageTitle>
      <PrintHeader hotel={chosen.name} from={range.from} to={range.to} />
      <PageIntro>Where bookings came from and who stayed, for the nights in the range. Days are the hotel&rsquo;s own days.</PageIntro>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 print:hidden">
        {allowed.length > 1 && (
          <div>
            <label htmlFor="property" className="block text-sm">
              Property
            </label>
            <select id="property" name="property" defaultValue={chosen.id} className={inputClass}>
              {allowed.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="from" className="block text-sm">
            From
          </label>
          <input id="from" name="from" type="date" required defaultValue={range.from} className={inputClass} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm">
            To
          </label>
          <input id="to" name="to" type="date" required defaultValue={range.to} className={inputClass} />
        </div>
        <PendingButton className={buttonPrimary} pendingLabel="Saving…">
          Show
        </PendingButton>
        <PrintButton />
      </form>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm print:hidden">
        {presets(today).map((p) => (
          <Link key={p.label} href={qs(p.from, p.to)} className={linkClass}>
            {p.label}
          </Link>
        ))}
      </p>
      {range.trimmed && (
        <p role="status" className="mt-3 text-sm text-pending">
          That range is longer than {MAX_RANGE_DAYS} days, so the most recent {MAX_RANGE_DAYS} days are shown.
        </p>
      )}

      <h2 className="mt-8 font-display text-2xl">Booking channels</h2>
      {!channels ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          The channel report could not be loaded. Try again, or choose a shorter range.
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto print:overflow-visible">
            <table className="w-full min-w-[40rem] text-sm print:min-w-0">
              <caption className="sr-only">
                Bookings by channel from {channels.from} to {channels.to}
              </caption>
              <thead>
                <tr className={headRow}>
                  <th scope="col" className="py-2 pr-3 font-normal">
                    Source
                  </th>
                  <th scope="col" className={thNum}>
                    Bookings
                  </th>
                  <th scope="col" className={thNum}>
                    Room nights
                  </th>
                  <th scope="col" className={thNum}>
                    Room revenue
                  </th>
                  <th scope="col" className={thNum}>
                    Share
                  </th>
                  <th scope="col" className={thNum}>
                    Cancelled
                  </th>
                  <th scope="col" className={thNum}>
                    No-shows
                  </th>
                  <th scope="col" className={thNum}>
                    Lost
                  </th>
                </tr>
              </thead>
              <tbody>
                {channels.rows.map((r) => (
                  <tr
                    key={r.source}
                    className={`border-b border-line tabular-nums ${r.bookings + r.cancelled + r.no_shows === 0 ? "text-muted" : ""}`}
                  >
                    <th scope="row" className={thRowHead}>
                      {sourceLabel(r.source)}
                    </th>
                    <td className={tdNum}>{r.bookings || "–"}</td>
                    <td className={tdNum}>{r.room_nights || "–"}</td>
                    <td className={tdNum}>{r.room_revenue_minor ? money(r.room_revenue_minor) : "–"}</td>
                    <td className={tdNum}>{formatBp(shareBp(r.room_revenue_minor, channels.totals.room_revenue_minor))}</td>
                    <td className={tdNum}>{r.cancelled || "–"}</td>
                    <td className={tdNum}>{r.no_shows || "–"}</td>
                    <td className={tdNum}>{formatBp(lostBp(r))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={totalRow}>
                  <th scope="row" className="py-2 pr-3 text-left">
                    Total
                  </th>
                  <td className={tdNum}>{channels.totals.bookings}</td>
                  <td className={tdNum}>{channels.totals.room_nights}</td>
                  <td className={tdNum}>{money(channels.totals.room_revenue_minor)}</td>
                  <td className={tdNum}>{formatBp(shareBp(channels.totals.room_revenue_minor, channels.totals.room_revenue_minor))}</td>
                  <td className={tdNum}>{channels.totals.cancelled}</td>
                  <td className={tdNum}>{channels.totals.no_shows}</td>
                  <td className={tdNum}>{formatBp(lostBp(channels.totals))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {mayExport && (
            <p className="mt-3 text-sm print:hidden">
              <a href={csv("channels")} className={linkClass}>
                Download channels as CSV
              </a>
            </p>
          )}
          <ul className="mt-4 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted">
            <li>
              Bookings, room nights and room revenue count the nights of confirmed, checked-in and checked-out bookings that fall in the
              range, before tax. Unpaid holds do not count.
            </li>
            <li>
              Cancelled and No-shows are bookings that were due to arrive in the range. Lost is those two as a share of everything that was
              due to arrive.
            </li>
          </ul>
        </>
      )}

      <h2 className="mt-10 font-display text-2xl">No-shows</h2>
      {!noShows ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          The no-show list could not be loaded. Try again, or choose a shorter range.
        </p>
      ) : noShows.total === 0 ? (
        <p className="mt-4 text-sm text-muted">No bookings marked as no-shows were due to arrive in this range.</p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto print:overflow-visible">
            <table className="w-full min-w-[34rem] text-sm print:min-w-0">
              <caption className="sr-only">
                No-shows due to arrive from {noShows.from} to {noShows.to}
              </caption>
              <thead>
                <tr className={headRow}>
                  <th scope="col" className="py-2 pr-3 font-normal">
                    Arrival
                  </th>
                  {!noShows.links_hidden && (
                    <th scope="col" className="px-2 py-2 font-normal">
                      Booking
                    </th>
                  )}
                  {!noShows.names_hidden && (
                    <th scope="col" className="px-2 py-2 font-normal">
                      Guest
                    </th>
                  )}
                  <th scope="col" className="px-2 py-2 font-normal">
                    Source
                  </th>
                  <th scope="col" className={thNum}>
                    Nights
                  </th>
                  <th scope="col" className={thNum}>
                    Charge
                  </th>
                </tr>
              </thead>
              <tbody>
                {noShows.rows.map((r, i) => (
                  <tr key={r.reservation_id ?? `${r.arrival_date}-${i}`} className="border-b border-line tabular-nums">
                    <th scope="row" className={thRowHead}>
                      {formatDate(r.arrival_date)}
                    </th>
                    {!noShows.links_hidden && (
                      <td className="px-2 py-2">
                        {r.reservation_id ? (
                          <Link href={`/app/reservations/${r.reservation_id}`} className={linkClass}>
                            {r.booking_reference}
                          </Link>
                        ) : (
                          "–"
                        )}
                      </td>
                    )}
                    {!noShows.names_hidden && <td className="px-2 py-2">{r.guest_name ?? "–"}</td>}
                    <td className="px-2 py-2">{sourceLabel(r.source)}</td>
                    <td className={tdNum}>{r.nights}</td>
                    <td className={tdNum}>{chargeLabel(r.charge_minor, money)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={totalRow}>
                  <th scope="row" className="py-2 pr-3 text-left">
                    {noShows.total} {noShows.total === 1 ? "no-show" : "no-shows"}
                  </th>
                  <td colSpan={2 + (noShows.links_hidden ? 0 : 1) + (noShows.names_hidden ? 0 : 1)} />
                  <td className={tdNum}>{money(chargedMinor(noShows.rows))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {isCut(noShows) && (
            <p role="status" className="mt-3 text-sm text-pending">
              Showing the newest {noShows.rows.length} of {noShows.total}. Choose a shorter range to see the rest; the charge total covers
              only the rows shown.
            </p>
          )}
          {mayExport && (
            <p className="mt-3 text-sm print:hidden">
              <a href={csv("noshows")} className={linkClass}>
                Download no-shows as CSV
              </a>
            </p>
          )}
          <ul className="mt-4 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted">
            <li>
              Bookings marked as no-shows whose arrival day is in the range. Charge is what the booking&rsquo;s cancellation rules put on it
              when it was marked; a dash means nothing was charged or it was waived. Booking numbers and guest names show only to people who
              may see bookings and guests.
            </li>
          </ul>
        </>
      )}

      <h2 className="mt-10 font-display text-2xl">Guests</h2>
      {!guests ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          The guest report could not be loaded. Try again, or choose a shorter range.
        </p>
      ) : (
        <>
          <section aria-label="Guest totals" className="mt-4 grid gap-3 sm:grid-cols-3">
            <StatTile
              label="Guests who stayed"
              value={String(guests.guests_total)}
              note="different primary guests with a night in the range"
            />
            <StatTile label="New" value={String(guests.guests_new)} note="no earlier stay at this hotel" />
            <StatTile label="Returning" value={String(guests.guests_returning)} note="stayed here before the range" />
          </section>

          <div className="mt-6 grid gap-8 lg:grid-cols-2">
            <div>
              <h3 className="font-medium">Countries</h3>
              {guests.countries.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No stays in this range.</p>
              ) : (
                <table className="mt-2 w-full text-sm">
                  <caption className="sr-only">Guests by country</caption>
                  <thead>
                    <tr className={headRow}>
                      <th scope="col" className="py-2 pr-3 font-normal">
                        Country
                      </th>
                      <th scope="col" className={thNum}>
                        Guests
                      </th>
                      <th scope="col" className={thNum}>
                        Room nights
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {guests.countries.map((c) => (
                      <tr key={c.country} className="border-b border-line tabular-nums">
                        <th scope="row" className={thRowHead}>
                          {countryLabel(c.country)}
                        </th>
                        <td className={tdNum}>{c.guests}</td>
                        <td className={tdNum}>{c.room_nights}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h3 className="font-medium">Top guests by room revenue</h3>
              {guests.names_hidden ? (
                <p className="mt-2 text-sm text-muted">Guest names are shown only to people who may view guests.</p>
              ) : guests.top_guests.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No stays in this range.</p>
              ) : (
                <table className="mt-2 w-full text-sm">
                  <caption className="sr-only">Top guests</caption>
                  <thead>
                    <tr className={headRow}>
                      <th scope="col" className="py-2 pr-3 font-normal">
                        Guest
                      </th>
                      <th scope="col" className={thNum}>
                        Stays
                      </th>
                      <th scope="col" className={thNum}>
                        Nights
                      </th>
                      <th scope="col" className={thNum}>
                        Room revenue
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {guests.top_guests.map((g) => (
                      <tr key={g.guest_id} className="border-b border-line tabular-nums">
                        <th scope="row" className={thRowHead}>
                          {g.name}
                        </th>
                        <td className={tdNum}>{g.stays}</td>
                        <td className={tdNum}>{g.room_nights}</td>
                        <td className={tdNum}>{money(g.room_revenue_minor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          {mayExport && (
            <p className="mt-3 text-sm print:hidden">
              <a href={csv("guests")} className={linkClass}>
                Download guests as CSV
              </a>
            </p>
          )}
        </>
      )}
    </main>
  );
}
