import { buttonDanger, buttonPrimary, inputClass, Notice, ErrorBanner, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { createDefaultPlan, clearRates, setRates } from "@/lib/staff/rate-actions";
import { groupRanges, type StoredRate } from "@/lib/staff/rates";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type RoomType = { id: string; property_id: string; name: string; code: string; base_rate_minor: number; currency: string; status: string };

export default async function RatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, typeQ, planQ] = await Promise.all([
    supabase.from("properties").select("id, name, timezone").order("name"),
    supabase.from("room_types").select("id, property_id, name, code, base_rate_minor, currency, status").order("name"),
    supabase.from("rate_plans").select("id, property_id, is_default, status").eq("is_default", true),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const types = (typeQ.data ?? []) as RoomType[];
  const plans = new Map(((planQ.data ?? []) as { id: string; property_id: string; status: string }[]).map((p) => [p.property_id, p]));
  const loadError = Boolean(propQ.error || typeQ.error || planQ.error);
  const now = new Date();

  const manage = new Map<string, boolean>();
  await Promise.all(
    properties.map(async (p) => {
      const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "rate.manage" });
      manage.set(p.id, data === true);
    }),
  );

  // Price overrides from today onward, for each property's default plan.
  const planIds = [...plans.values()].map((p) => p.id);
  const earliest = properties.map((p) => todayIn(p.timezone, now)).sort()[0];
  const rateQ =
    planIds.length && earliest
      ? await supabase
          .from("daily_rates")
          .select("room_type_id, rate_plan_id, business_date, amount_minor")
          .in("rate_plan_id", planIds)
          .gte("business_date", earliest)
          .order("business_date")
          .limit(5000)
      : { data: [] };
  const rates = (rateQ.data ?? []) as { room_type_id: string; rate_plan_id: string; business_date: string; amount_minor: number }[];
  const many = properties.length > 1;

  return (
    <main className="max-w-4xl">
      <PageTitle>Rates</PageTitle>
      <PageIntro>
        Each room type has a standard nightly price. Set a different price for a date range, such as a holiday week, and bookings for those
        nights use it. Prices already booked do not change.
      </PageIntro>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {loadError && <ErrorBanner className="mb-6">The rates could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const plan = plans.get(p.id);
        const canManage = manage.get(p.id) === true;
        const today = todayIn(p.timezone, now);
        const myTypes = types.filter((t) => t.property_id === p.id);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}

            {!plan && (
              <div className="mt-3 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">
                <p className="font-medium">No standard rate plan yet.</p>
                <p className="mt-1 max-w-prose">
                  Every booking is priced from the hotel's standard rate plan, so until one exists no reservation can be made, in person or
                  online.
                </p>
                {canManage && (
                  <form action={createDefaultPlan} className="mt-3">
                    <input type="hidden" name="propertyId" value={p.id} />
                    <PendingButton className={buttonPrimary} pendingLabel="Creating…">
                      Create the standard rate plan
                    </PendingButton>
                  </form>
                )}
              </div>
            )}

            {myTypes.length === 0 && (
              <p className="mt-3 text-muted">No room types yet. Add them under Settings, then set their rates here.</p>
            )}

            {myTypes.map((t) => {
              const mine: StoredRate[] = plan ? rates.filter((r) => r.rate_plan_id === plan.id && r.room_type_id === t.id) : [];
              const ranges = groupRanges(mine);
              return (
                <div key={t.id} className="mt-5 rounded border border-line bg-white p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h3 className="text-lg font-semibold">
                      {t.name} <span className="text-sm font-normal text-muted">{t.code}</span>
                    </h3>
                    <p className="tabular-nums">
                      {formatMoney(t.base_rate_minor, t.currency)} <span className="text-sm text-muted">standard</span>
                    </p>
                  </div>

                  <h4 className="mt-3 text-sm font-medium">Different prices coming up</h4>
                  {ranges.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">None. Every night uses the standard price.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line border-y border-line text-sm">
                      {ranges.map((r) => (
                        <li key={r.from} className="flex flex-wrap items-baseline justify-between gap-x-6 py-2">
                          <span>
                            {r.from === r.to ? formatDate(r.from) : `${formatDate(r.from)} to ${formatDate(r.to)}`}
                            <span className="ml-2 text-muted">
                              {r.nights} {r.nights === 1 ? "night" : "nights"}
                            </span>
                          </span>
                          <span className="tabular-nums font-medium">{formatMoney(r.amountMinor, t.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {canManage && plan && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-medium text-primary-strong">Change prices for dates</summary>
                      <div className="mt-3 grid gap-5 sm:grid-cols-2">
                        <form action={setRates} className="grid gap-3">
                          <input type="hidden" name="propertyId" value={p.id} />
                          <input type="hidden" name="roomTypeId" value={t.id} />
                          <p className="text-sm font-medium">Set a price</p>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`sf-${t.id}`} className="block text-xs text-muted">
                                First night
                              </label>
                              <input
                                id={`sf-${t.id}`}
                                name="from"
                                type="date"
                                required
                                min={today}
                                defaultValue={today}
                                className={inputClass}
                              />
                            </div>
                            <div>
                              <label htmlFor={`st-${t.id}`} className="block text-xs text-muted">
                                Last night
                              </label>
                              <input id={`st-${t.id}`} name="to" type="date" required min={today} className={inputClass} />
                            </div>
                          </div>
                          <div>
                            <label htmlFor={`sa-${t.id}`} className="block text-xs text-muted">
                              Price a night (₦)
                            </label>
                            <input
                              id={`sa-${t.id}`}
                              name="amount"
                              inputMode="decimal"
                              required
                              placeholder="60,000"
                              className={`${inputClass} tabular-nums`}
                            />
                          </div>
                          <div>
                            <PendingButton className={buttonPrimary} pendingLabel="Saving…">
                              Save price
                            </PendingButton>
                          </div>
                        </form>
                        <form action={clearRates} className="grid gap-3">
                          <input type="hidden" name="propertyId" value={p.id} />
                          <input type="hidden" name="roomTypeId" value={t.id} />
                          <p className="text-sm font-medium">Go back to the standard price</p>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`cf-${t.id}`} className="block text-xs text-muted">
                                First night
                              </label>
                              <input
                                id={`cf-${t.id}`}
                                name="from"
                                type="date"
                                required
                                min={today}
                                defaultValue={today}
                                className={inputClass}
                              />
                            </div>
                            <div>
                              <label htmlFor={`ct-${t.id}`} className="block text-xs text-muted">
                                Last night
                              </label>
                              <input id={`ct-${t.id}`} name="to" type="date" required min={today} className={inputClass} />
                            </div>
                          </div>
                          <div>
                            <PendingButton className={buttonDanger} pendingLabel="Removing…">
                              Remove different prices
                            </PendingButton>
                          </div>
                        </form>
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      <p className="mt-10 text-xs text-muted">Taxes are added on top of these prices by the hotel's tax rules.</p>
    </main>
  );
}
