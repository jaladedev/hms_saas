import Link from "next/link";
import { PendingButton } from "@/components/ui/pending-button";
import {
  buttonPrimary,
  cardClass,
  EmptyState,
  ErrorBanner,
  headRow,
  inputClass,
  linkClass,
  Notice,
  PageIntro,
  PageTitle,
  SectionTitle,
  tdNum,
  thNum,
  thRowHead,
} from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { rememberedProperty } from "@/lib/staff/active-property";
import {
  figuresChanged,
  openItemsLabel,
  parseDay,
  parseDays,
  parsePreview,
  type AuditPreview,
  type DayFigures,
  type ItemRef,
} from "@/lib/staff/night-audit";
import { closeDay } from "@/lib/staff/night-audit-actions";
import { pickProperty } from "@/lib/staff/property-choice";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const CUR = "NGN";
const money = (m: number) => formatMoney(m, CUR);

// What each figure is called and how it is shown. Amounts are naira; the first row is a count of nights.
const FIGURE_ROWS: { key: keyof DayFigures; label: string; count?: boolean }[] = [
  { key: "rooms_sold", label: "Nights sold", count: true },
  { key: "room_revenue_minor", label: "Room revenue, before tax" },
  { key: "room_tax_minor", label: "Tax on rooms" },
  { key: "room_service_minor", label: "Service charge on rooms" },
  { key: "extras_minor", label: "Extras, before tax" },
  { key: "extras_tax_minor", label: "Tax on extras" },
  { key: "cash_in_minor", label: "Money received" },
  { key: "refunds_paid_minor", label: "Refunds paid out" },
];
const show = (v: number, count?: boolean) => (count ? String(v) : money(v));

function RefList({ title, total, refs, empty }: { title: string; total: number; refs: ItemRef[]; empty: string }) {
  return (
    <div className={cardClass}>
      <h3 className="flex items-baseline justify-between gap-3 text-sm font-medium">
        <span>{title}</span>
        <span className={total > 0 ? "text-critical" : "text-muted"}>{total}</span>
      </h3>
      {refs.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {refs.map((r) => (
            <li key={`${r.reservation_id}-${r.booking_reference}`}>
              <Link href={`/app/reservations/${r.reservation_id}`} className={linkClass}>
                {r.booking_reference}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > refs.length && (
        <p className="mt-2 text-xs text-muted">Showing the first {refs.length}. Deal with these and reload to see the rest.</p>
      )}
    </div>
  );
}

function FiguresTable({ preview }: { preview: AuditPreview }) {
  const kept = preview.closed ? preview.kept_figures : null;
  const changed = kept ? figuresChanged(kept, preview.figures) : false;
  return (
    <>
      {changed && (
        <p role="status" className="mb-3 border-l-4 border-pending bg-pending/10 px-4 py-3 text-sm text-pending">
          Something changed for this day after it was closed, such as a payment or a charge added late. The figures kept at close are on the
          left; today&rsquo;s figures for the same day are on the right.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] text-sm tabular-nums">
          <thead>
            <tr className={headRow}>
              <th scope="col" className={thRowHead}>
                Figure
              </th>
              {kept && (
                <th scope="col" className={thNum}>
                  Kept at close
                </th>
              )}
              <th scope="col" className={thNum}>
                {kept ? "Now" : "So far"}
              </th>
            </tr>
          </thead>
          <tbody>
            {FIGURE_ROWS.map((r) => (
              <tr key={r.key} className="border-b border-line">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {r.label}
                </th>
                {kept && <td className={tdNum}>{show(kept[r.key], r.count)}</td>}
                <td className={`${tdNum} ${kept && kept[r.key] !== preview.figures[r.key] ? "font-semibold text-pending" : ""}`}>
                  {show(preview.figures[r.key], r.count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default async function NightAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, timezone").order("name");
  const all = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  // Only hotels this person may close days for; the database checks again on every call.
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "day.close" });
        return data === true ? p : null;
      }),
    )
  ).filter((p): p is { id: string; name: string; timezone: string } => p !== null);

  const heading = <PageTitle>Night audit</PageTitle>;
  if (propQ.error)
    return (
      <main className="max-w-4xl">
        {heading}
        <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
      </main>
    );
  const property = pickProperty(allowed, first(search.property), await rememberedProperty());
  if (!property)
    return (
      <main className="max-w-4xl">
        {heading}
        <p className="mt-4 max-w-prose text-muted">
          Closing the day is for the owner, general manager and accountant. Ask one of them if a day needs closing.
        </p>
      </main>
    );

  const today = todayIn(property.timezone, new Date());
  const day = parseDay(first(search.day), today);
  const [previewQ, daysQ] = await Promise.all([
    supabase.rpc("night_audit_preview", { p_property: property.id, p_day: day }),
    supabase.rpc("night_audit_days", { p_property: property.id, p_days: 14 }),
  ]);
  const preview = previewQ.error ? null : parsePreview(previewQ.data);
  const days = daysQ.error ? [] : parseDays(daysQ.data);
  const items = preview?.items;

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Check what is still open at the end of the day, then close it. Closing keeps the day&rsquo;s figures as they are now, so a later
        change cannot quietly rewrite a day you have signed off. Nothing is posted and nothing is locked: a payment or charge added
        afterwards still goes through, and the day then shows as changed since it was closed.
      </PageIntro>

      <div className="mt-6">
        <Notice search={search} currency={CUR} />
      </div>

      <form method="get" className="flex flex-wrap items-end gap-4 print:hidden">
        {allowed.length > 1 && (
          <label className="text-sm">
            Hotel
            <select name="property" defaultValue={property.id} className={`${inputClass} mt-1 block`}>
              {allowed.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          Day
          <input type="date" name="day" defaultValue={day} max={today} className={`${inputClass} mt-1 block`} />
        </label>
        <PendingButton className={buttonPrimary} pendingLabel="Loading…">
          Show
        </PendingButton>
      </form>

      {!preview || !items ? (
        <ErrorBanner className="mt-6">This day could not be loaded. Try again.</ErrorBanner>
      ) : (
        <>
          <p className="mt-6 flex flex-wrap items-center gap-2 text-lg font-medium">
            {formatDate(preview.day)}
            {preview.day === preview.today && (
              <span className="rounded-full bg-ink/5 px-2.5 py-0.5 text-xs font-normal text-muted">Today</span>
            )}
            {preview.closed ? (
              <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-white">Closed</span>
            ) : (
              <span className="rounded-full bg-ink/5 px-2.5 py-0.5 text-xs font-normal text-muted">Not closed</span>
            )}
          </p>
          {preview.closed && (
            <p className="mt-1 text-sm text-muted">
              Closed on {preview.closed_at ? formatDate(preview.closed_at.slice(0, 10)) : "an earlier day"}.
              {preview.override_note ? ` Note kept with it: ${preview.override_note}` : ""}
            </p>
          )}

          <section aria-labelledby="open-items" className="mt-8">
            <SectionTitle id="open-items">What is still open</SectionTitle>
            <p className="mt-1 text-sm text-muted">
              {preview.closed ? "Open as of now. " : ""}
              {openItemsLabel(items.total)}. Each booking number opens that booking.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <RefList
                title="Should be in house, not checked in"
                total={items.arrivals_not_checked_in}
                refs={items.arrivals}
                empty="Everyone expected has checked in."
              />
              <RefList
                title="Stay ended, not checked out"
                total={items.departures_not_checked_out}
                refs={items.departures}
                empty="Everyone due out has checked out."
              />
              <div className={cardClass}>
                <h3 className="flex items-baseline justify-between gap-3 text-sm font-medium">
                  <span>Payments nobody has checked</span>
                  <span className={items.unverified_payments > 0 ? "text-critical" : "text-muted"}>{items.unverified_payments}</span>
                </h3>
                {items.payments.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">Every payment up to this day is checked.</p>
                ) : (
                  <>
                    <p className="mt-2 text-sm">
                      {money(items.unverified_payments_minor)} in bank transfers and other payments.{" "}
                      <Link href="/app/payments" className={linkClass}>
                        Check them
                      </Link>
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      {items.payments.map((p) => (
                        <li key={`${p.reservation_id}-${p.amount_minor}-${p.booking_reference}`}>
                          <Link href={`/app/reservations/${p.reservation_id}`} className={linkClass}>
                            {p.booking_reference}
                          </Link>{" "}
                          <span className="text-muted">{money(p.amount_minor)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="day-figures" className="mt-8">
            <SectionTitle id="day-figures">The day&rsquo;s figures</SectionTitle>
            <div className="mt-3">
              <FiguresTable preview={preview} />
            </div>
          </section>

          {!preview.closed && (
            <section aria-labelledby="close-day" className="mt-8">
              <SectionTitle id="close-day">Close this day</SectionTitle>
              <form action={closeDay} className="mt-3 max-w-xl">
                <input type="hidden" name="property" value={property.id} />
                <input type="hidden" name="day" value={preview.day} />
                <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                {items.total > 0 ? (
                  <label className="block text-sm">
                    Why are you closing it with items still open?
                    <textarea
                      name="note"
                      required
                      minLength={5}
                      maxLength={500}
                      rows={3}
                      className={`${inputClass} mt-1 block w-full`}
                      placeholder="For example: late arrival expected, transfer slip to be checked tomorrow"
                    />
                    <span className="mt-1 block text-xs text-muted">
                      Kept with the day, together with the list above. 5 to 500 characters.
                    </span>
                  </label>
                ) : (
                  <p className="text-sm text-muted">Nothing is open, so no note is needed.</p>
                )}
                <div className="mt-4">
                  <PendingButton className={buttonPrimary} pendingLabel="Closing…">
                    Close {formatDate(preview.day)}
                  </PendingButton>
                </div>
              </form>
            </section>
          )}
        </>
      )}

      <section aria-labelledby="recent-days" className="mt-10">
        <SectionTitle id="recent-days">The last 14 days</SectionTitle>
        {days.length === 0 ? (
          <EmptyState className="mt-3">The recent days could not be loaded.</EmptyState>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm tabular-nums">
              <thead>
                <tr className={headRow}>
                  <th scope="col" className={thRowHead}>
                    Day
                  </th>
                  <th scope="col" className="py-2 pr-3 text-left font-normal">
                    State
                  </th>
                  <th scope="col" className={thNum}>
                    Money received
                  </th>
                  <th scope="col" className={thNum}>
                    Open at close
                  </th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day} className="border-b border-line">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <Link
                        href={`/app/night-audit?${new URLSearchParams({ property: property.id, day: d.day })}`}
                        className={linkClass}
                        aria-current={d.day === day ? "date" : undefined}
                      >
                        {formatDate(d.day)}
                      </Link>
                    </th>
                    <td className="py-2 pr-3">
                      {d.closed ? "Closed" : <span className="text-muted">Not closed</span>}
                      {d.changed_since_close === true && (
                        <span className="ml-2 rounded-full bg-pending/10 px-2 py-0.5 text-xs text-pending">Changed since close</span>
                      )}
                    </td>
                    <td className={tdNum}>{money(d.figures.cash_in_minor)}</td>
                    <td className={tdNum}>{d.closed ? (d.open_items ?? 0) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
