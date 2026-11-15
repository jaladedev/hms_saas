import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { deletePromoCode, savePromoCode } from "@/lib/staff/hotel-profile-actions";
import { minorToInput } from "@/lib/staff/money-input";
import {
  MAX_PROMO_CODES,
  MAX_PROMO_PERCENT,
  parsePromoList,
  promoValueText,
  promoWindowText,
  type PromoRow,
} from "@/lib/staff/promo-codes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Promo codes a guest types on the website's booking form. A code takes a percentage (1 to 90) or a fixed amount off the booking
 * (room charges plus tax, the same way a discount does) and is never more than 90 percent. People who may change the hotel setup
 * (property.configure) see the list; the database makes the final decision on every save.
 */
export default async function PromoCodesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name, currency").order("name");
  const properties = (props ?? []) as { id: string; name: string; currency: string }[];
  const results = await Promise.all(properties.map((p) => supabase.rpc("promo_code_list", { p_property: p.id })));
  // A hotel the person may not manage answers NOT_FOUND and is left out; any other failure is shown.
  const failed = Boolean(propError) || results.some((r) => r.error && !/NOT_FOUND/.test(r.error.message));
  const many = properties.length > 1;

  return (
    <main className="max-w-3xl">
      <PageTitle>Promo codes</PageTitle>
      <PageIntro>
        A code a guest types on your website&rsquo;s booking form takes a percentage (1 to {MAX_PROMO_PERCENT}) or a fixed amount off the
        room charges and tax, and is never more than {MAX_PROMO_PERCENT} percent. The guest sees the discount on their booking. The dates
        are the days a guest may <em>book</em> in, not the stay dates. A booking that is cancelled or expires gives its use back. Staff can
        still give a discount on a booking from the reservation page. Up to {MAX_PROMO_CODES} codes.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {failed && <ErrorBanner className="mb-6">The promo codes could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        if (results[i]?.error) return null;
        const mine = parsePromoList(results[i]?.data);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            <ul className="mt-4 space-y-4">
              {mine.map((c) => (
                <li key={c.id} className="rounded border border-line bg-white p-4">
                  <p className="text-sm">
                    <strong>{c.code}</strong> · {promoValueText(c, (m) => formatMoney(m, p.currency))} ·{" "}
                    {promoWindowText(c.valid_from, c.valid_to, formatDate)} ·{" "}
                    {c.max_uses === null ? `${c.used} used` : `${c.used} of ${c.max_uses} used`} ·{" "}
                    {c.is_active ? "switched on" : "switched off"}
                  </p>
                  <PromoForm propertyId={p.id} promo={c} />
                  {!c.ever_used && (
                    <form action={deletePromoCode} className="mt-2">
                      <input type="hidden" name="promoId" value={c.id} />
                      <PendingButton className={buttonQuiet} pendingLabel="Deleting…">
                        Delete this code
                      </PendingButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            {mine.length === 0 && <p className="mt-4 text-sm text-muted">No promo codes yet.</p>}
            {mine.length < MAX_PROMO_CODES && (
              <div className="mt-6 rounded border border-dashed border-line bg-white p-4">
                <h3 className="text-sm font-medium">Add a promo code</h3>
                <PromoForm propertyId={p.id} promo={null} />
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

function PromoForm({ propertyId, promo }: { propertyId: string; promo: PromoRow | null }) {
  const id = promo?.id ?? "new";
  return (
    <form action={savePromoCode} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="promoId" value={promo?.id ?? ""} />
      <label className="block text-sm" htmlFor={`c-${id}`}>
        Code
        {promo ? (
          <>
            <input type="hidden" name="code" value={promo.code} />
            <input id={`c-${id}`} value={promo.code} readOnly className={`${inputClass} mt-1 bg-paper`} />
          </>
        ) : (
          <input
            id={`c-${id}`}
            name="code"
            required
            minLength={3}
            maxLength={24}
            placeholder="SPRING10"
            autoCapitalize="characters"
            className={`${inputClass} mt-1 uppercase`}
          />
        )}
      </label>
      <fieldset className="text-sm">
        <legend>Takes off</legend>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="kind"
              value="percent"
              defaultChecked={!promo || promo.kind === "percent"}
              className="accent-primary"
            />
            Percent
          </label>
          <input
            name="percent"
            inputMode="decimal"
            aria-label="Percent off"
            placeholder="10"
            defaultValue={promo?.kind === "percent" ? String(promo.percent ?? "") : ""}
            className={`${inputClass} w-20`}
          />
          <label className="flex items-center gap-1">
            <input type="radio" name="kind" value="amount" defaultChecked={promo?.kind === "amount"} className="accent-primary" />
            Amount
          </label>
          <input
            name="amount"
            inputMode="decimal"
            aria-label="Amount off"
            placeholder="5000"
            defaultValue={promo?.kind === "amount" && promo.amount_minor ? minorToInput(promo.amount_minor) : ""}
            className={`${inputClass} w-28`}
          />
        </div>
      </fieldset>
      <label className="block text-sm" htmlFor={`f-${id}`}>
        Guests may book from (optional)
        <input id={`f-${id}`} name="validFrom" type="date" defaultValue={promo?.valid_from ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`u-${id}`}>
        Guests may book until (optional)
        <input id={`u-${id}`} name="validTo" type="date" defaultValue={promo?.valid_to ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`n-${id}`}>
        Minimum nights
        <input
          id={`n-${id}`}
          name="minNights"
          type="number"
          min={1}
          max={30}
          step={1}
          defaultValue={promo?.min_nights ?? 1}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm" htmlFor={`m-${id}`}>
        Most bookings (empty for no limit)
        <input
          id={`m-${id}`}
          name="maxUses"
          type="number"
          min={1}
          step={1}
          defaultValue={promo?.max_uses ?? ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2" htmlFor={`a-${id}`}>
        <input id={`a-${id}`} name="active" type="checkbox" defaultChecked={promo ? promo.is_active : true} className="accent-primary" />
        Switched on
      </label>
      <div className="sm:col-span-2">
        <PendingButton className={buttonPrimary} pendingLabel="Working…">
          {promo ? "Save code" : "Add code"}
        </PendingButton>
      </div>
    </form>
  );
}
