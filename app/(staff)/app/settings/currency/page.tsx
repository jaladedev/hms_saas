import { buttonPrimary, cardClass, EmptyState, ErrorBanner, inputClass, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { CURRENCY_LABEL, SUPPORTED_CURRENCIES } from "@/lib/currency";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";
import { saveRate } from "@/lib/staff/currency-actions";
import { FX_ERROR_MESSAGES, FX_OK_MESSAGES, parseRates, type FxErrorCode, type FxOkCode } from "@/lib/staff/currency-rates";
import { todayIn } from "@/lib/staff/reservations";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Currency and exchange rates (migration 163). A hotel has one currency, set when the hotel is created (a change is possible only before
 * its first booking, and is done by the platform). Rates here are dated and entered by hand; no booking, bill or payment uses one.
 */
export default async function CurrencyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, currency, timezone").order("name");
  const all = (propQ.data ?? []) as { id: string; name: string; currency: string; timezone: string }[];
  const allowed = (
    await Promise.all(
      all.map(async (p) =>
        (await supabase.rpc("has_permission", { p_property: p.id, p_permission: "property.configure" })).data === true ? p : null,
      ),
    )
  ).filter((p): p is (typeof all)[number] => p !== null);
  const property = pickProperty(allowed, first(search.property), await rememberedProperty());
  const heading = <PageTitle>Currency and exchange rates</PageTitle>;
  if (propQ.error || !property)
    return (
      <main className="max-w-3xl">
        {heading}
        <p className="mt-4 max-w-prose text-muted">Currency settings are for the owner and general manager.</p>
      </main>
    );
  const ratesQ = await supabase
    .from("exchange_rates")
    .select("id, from_currency, to_currency, rate_date, rate, note")
    .order("rate_date", { ascending: false })
    .limit(60);
  const rates = parseRates(ratesQ.data);
  const err = first(search.fxerr);
  const ok = first(search.fx);
  const today = todayIn(property.timezone, new Date());
  return (
    <main className="max-w-3xl">
      {heading}
      <PageIntro>
        This hotel trades in <strong>{CURRENCY_LABEL[property.currency as keyof typeof CURRENCY_LABEL] ?? property.currency}</strong>. Every
        booking, bill, payment and refund is in that currency, and nothing is converted. Rates below are for comparing hotels in different
        currencies on a report; no money screen uses them.
      </PageIntro>
      <div className="mt-5">
        {err && err in FX_ERROR_MESSAGES && <ErrorBanner className="mb-5">{FX_ERROR_MESSAGES[err as FxErrorCode]}</ErrorBanner>}
        {ok && ok in FX_OK_MESSAGES && (
          <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
            {FX_OK_MESSAGES[ok as FxOkCode]}
          </p>
        )}
      </div>
      <form action={saveRate} className={cardClass}>
        <input type="hidden" name="propertyId" value={property.id} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-xs" htmlFor="from">
            1 unit of
            <select id="from" name="from" defaultValue="USD" className={`${inputClass} mt-1`}>
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs" htmlFor="rate">
            equals
            <input id="rate" name="rate" required inputMode="decimal" className={`${inputClass} mt-1 w-32`} />
          </label>
          <label className="block text-xs" htmlFor="to">
            units of
            <select id="to" name="to" defaultValue="NGN" className={`${inputClass} mt-1`}>
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs" htmlFor="date">
            On
            <input id="date" name="date" type="date" required max={today} defaultValue={today} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-xs" htmlFor="note">
            Source
            <input id="note" name="note" maxLength={200} className={`${inputClass} mt-1 w-40`} />
          </label>
          <PendingButton className={buttonPrimary}>Save rate</PendingButton>
        </div>
      </form>
      <section className="mt-8" aria-label="Rates">
        <SectionTitle>Rates entered</SectionTitle>
        {rates.length === 0 ? (
          <EmptyState className="mt-3">No rates yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {rates.map((r) => (
              <li key={r.id} className={cardClass}>
                <p className="font-medium">
                  1 {r.from} = {r.rate} {r.to} <span className="text-xs font-normal text-muted">on {r.date}</span>
                </p>
                {r.note && <p className="text-sm text-muted">{r.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
