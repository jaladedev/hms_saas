import { buttonPrimary, buttonQuiet, inputClass, Notice, ErrorBanner, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { todayIn } from "@/lib/staff/reservations";
import { addTaxRule, setExtrasTax, updateTaxRule } from "@/lib/staff/tax-actions";
import {
  appliesLine, canApplyToExtras, describeRate, extrasTaxRules, nextSequence, rateInputValue, RULE_NAME_MAX, ruleState, sortRules, STATE_LABEL, TAX_RULE_COLUMNS, type TaxRuleRow,
} from "@/lib/staff/tax-rules";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Tax rules: which rules the hotel charges, and which of them also tax the extras posted to a guest's folio.
 * Nights are taxed by every rule in force; extras only by the percent rules marked here, and nothing is marked
 * until a person does it. Changing the mark affects extras posted from then on; a charge already posted keeps the
 * tax it was posted with. Only people with property.configure may change it (the database decides), and the change
 * is recorded in the audit log. People with property.configure can also add a rule and edit one (name, rate, order,
 * dates, switched on or off); the kind of tax (percent or fixed) is chosen when the rule is added and never edited.
 */
export default async function TaxRulesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const now = new Date();
  const [propQ, ruleQ] = await Promise.all([
    supabase.from("properties").select("id, name, timezone").order("name"),
    supabase.from("tax_rules").select(TAX_RULE_COLUMNS).limit(500),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const rules = sortRules((ruleQ.data ?? []) as TaxRuleRow[]);
  const loadError = Boolean(propQ.error || ruleQ.error);

  const canConfigure = new Map<string, boolean>();
  await Promise.all(properties.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "property.configure" });
    canConfigure.set(p.id, data === true);
  }));
  const many = properties.length > 1;

  return (
    <main className="max-w-4xl">
      <PageTitle>Tax rules</PageTitle>
      <PageIntro>
        Every tax rule in force is added to each night of a stay. Extras posted to a guest's folio, such as the minibar or laundry, are taxed only by the percentage rules you switch on here. Nothing is switched on until you do it, so until then extras carry no tax.
      </PageIntro>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <ErrorBanner className="mb-6">The tax rules could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const mine = rules.filter((r) => r.property_id === p.id);
        const today = todayIn(p.timezone, now);
        const manage = canConfigure.get(p.id) === true;
        const taxing = extrasTaxRules(rules, p.id, today);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}

            <p className="mt-3 text-sm" aria-live="polite">
              {taxing.length === 0
                ? <><span className="font-medium">Extras are not taxed.</span> <span className="text-muted">No percentage rule in force is switched on for extras.</span></>
                : <><span className="font-medium">Extras are taxed with:</span> {taxing.map((r) => `${r.name} (${describeRate(r, (m) => formatMoney(m, "NGN"))})`).join(", ")}.</>}
            </p>

            {mine.length === 0 ? (
              <p className="mt-4 text-muted">This hotel has no tax rules, so no tax is added to nights or extras.</p>
            ) : (
              <ul className="mt-4 divide-y divide-line border-y border-line">
                {mine.map((r) => {
                  const state = ruleState(r, today);
                  const dates = r.effective_to ? `${formatDate(r.effective_from)} to ${formatDate(r.effective_to)}` : `From ${formatDate(r.effective_from)}`;
                  return (
                    <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-4">
                      <div className="min-w-0 max-w-prose">
                        <p className="font-medium">
                          {r.name} <span className="tabular-nums text-muted">{describeRate(r, (m) => formatMoney(m, "NGN"))}</span>
                          <span className={`ml-2 rounded border px-1.5 py-0.5 text-xs font-normal ${state === "in_force" ? "border-primary/40 text-primary-strong" : "border-line text-muted"}`}>{STATE_LABEL[state]}</span>
                        </p>
                        <p className="mt-1 text-sm text-muted">{dates}{r.compounds ? ", applied on top of the rules before it" : ""}</p>
                        <p className="mt-1 text-sm">{appliesLine(r)}</p>
                        {r.applies_to_charges && state !== "in_force" && (
                          <p className="mt-1 text-sm text-muted">Switched on for extras, but it does not tax anything while it is {STATE_LABEL[state].toLowerCase()}.</p>
                        )}
                      </div>
                      {manage && canApplyToExtras(r) && (
                        <form action={setExtrasTax}>
                          <input type="hidden" name="ruleId" value={r.id} />
                          <input type="hidden" name="apply" value={r.applies_to_charges ? "off" : "on"} />
                          <button type="submit" className={r.applies_to_charges ? buttonQuiet : buttonPrimary}>
                            {r.applies_to_charges ? "Stop taxing extras" : "Tax extras with this rule"}
                          </button>
                        </form>
                      )}
                      {manage && (
                        <details className="w-full">
                          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Edit {r.name}</summary>
                          <form action={updateTaxRule} className="mt-3 grid gap-4 sm:grid-cols-2">
                            <input type="hidden" name="ruleId" value={r.id} />
                            <div>
                              <label htmlFor={`tn-${r.id}`} className="block text-sm">Name</label>
                              <input id={`tn-${r.id}`} name="name" required maxLength={RULE_NAME_MAX} defaultValue={r.name} className={inputClass} />
                            </div>
                            <div>
                              <label htmlFor={`tr-${r.id}`} className="block text-sm">{r.basis === "percent" ? "Rate (%)" : "Amount a night (₦)"}</label>
                              <input id={`tr-${r.id}`} name="rate" inputMode="decimal" required defaultValue={rateInputValue(r)} className={`${inputClass} tabular-nums`} />
                            </div>
                            <div>
                              <label htmlFor={`tf-${r.id}`} className="block text-sm">First day</label>
                              <input id={`tf-${r.id}`} name="effectiveFrom" type="date" required defaultValue={r.effective_from} className={inputClass} />
                            </div>
                            <div>
                              <label htmlFor={`tt-${r.id}`} className="block text-sm">Last day (leave empty if it has no end)</label>
                              <input id={`tt-${r.id}`} name="effectiveTo" type="date" defaultValue={r.effective_to ?? ""} className={inputClass} />
                            </div>
                            <div>
                              <label htmlFor={`ts-${r.id}`} className="block text-sm">Order</label>
                              <input id={`ts-${r.id}`} name="sequence" type="number" inputMode="numeric" min={1} max={999} required defaultValue={r.sequence} className={inputClass} />
                              <p className="mt-1 text-xs text-muted">Rules are applied in this order, lowest first.</p>
                            </div>
                            <div>
                              <label htmlFor={`tu-${r.id}`} className="block text-sm">Status</label>
                              <select id={`tu-${r.id}`} name="status" defaultValue={r.status === "active" ? "active" : "inactive"} className={inputClass}>
                                <option value="active">Switched on</option>
                                <option value="inactive">Switched off</option>
                              </select>
                            </div>
                            {r.basis === "percent" && (
                              <div className="flex items-center gap-2 sm:col-span-2">
                                <input id={`tc-${r.id}`} name="compounds" type="checkbox" defaultChecked={r.compounds} className="h-4 w-4" />
                                <label htmlFor={`tc-${r.id}`} className="text-sm">Apply on top of the rules before it (tax on tax)</label>
                              </div>
                            )}
                            <p className="text-xs text-muted sm:col-span-2">
                              A change applies to quotes and bookings made from now on. Bookings already made and charges already posted keep their tax. To change a rate from a certain day, set this rule&apos;s last day to the day before and add a new rule that starts on that day.
                            </p>
                            <div className="sm:col-span-2"><button type="submit" className={buttonPrimary}>Save changes</button></div>
                          </form>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {manage && (
              <details className="mt-6">
                <summary className="cursor-pointer text-sm font-medium text-primary-strong">Add a tax rule</summary>
                <form action={addTaxRule} className="mt-3 grid gap-4 sm:grid-cols-2">
                  <input type="hidden" name="propertyId" value={p.id} />
                  <div>
                    <label htmlFor={`an-${p.id}`} className="block text-sm">Name</label>
                    <input id={`an-${p.id}`} name="name" required maxLength={RULE_NAME_MAX} placeholder="VAT" className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor={`ab-${p.id}`} className="block text-sm">Kind of tax</label>
                    <select id={`ab-${p.id}`} name="basis" defaultValue="percent" className={inputClass}>
                      <option value="percent">A percentage of the night&apos;s price</option>
                      <option value="fixed_per_night">A fixed amount each night</option>
                    </select>
                    <p className="mt-1 text-xs text-muted">This cannot be changed later.</p>
                  </div>
                  <div>
                    <label htmlFor={`ar-${p.id}`} className="block text-sm">Rate</label>
                    <input id={`ar-${p.id}`} name="rate" inputMode="decimal" required placeholder="7.5" className={`${inputClass} tabular-nums`} />
                    <p className="mt-1 text-xs text-muted">A percentage: 7.5 means 7.5%. A fixed amount: naira a night, such as 1,000.</p>
                  </div>
                  <div>
                    <label htmlFor={`as-${p.id}`} className="block text-sm">Order (optional)</label>
                    <input id={`as-${p.id}`} name="sequence" type="number" inputMode="numeric" min={1} max={999} placeholder={String(nextSequence(mine))} className={inputClass} />
                    <p className="mt-1 text-xs text-muted">Rules are applied lowest first. Left empty, this one goes last.</p>
                  </div>
                  <div>
                    <label htmlFor={`af-${p.id}`} className="block text-sm">First day</label>
                    <input id={`af-${p.id}`} name="effectiveFrom" type="date" required defaultValue={today} className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor={`at-${p.id}`} className="block text-sm">Last day (leave empty if it has no end)</label>
                    <input id={`at-${p.id}`} name="effectiveTo" type="date" className={inputClass} />
                  </div>
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <input id={`ac-${p.id}`} name="compounds" type="checkbox" className="h-4 w-4" />
                    <label htmlFor={`ac-${p.id}`} className="text-sm">Percentage only: apply on top of the rules before it (tax on tax)</label>
                  </div>
                  <p className="text-xs text-muted sm:col-span-2">
                    A new rule is added to every night priced from its first day. Extras stay untaxed until you switch that on for the rule.
                  </p>
                  <div className="sm:col-span-2"><button type="submit" className={buttonPrimary}>Add tax rule</button></div>
                </form>
              </details>
            )}

            {!manage && mine.length > 0 && <p className="mt-3 text-sm text-muted">You can see these rules but not change them.</p>}
          </section>
        );
      })}

      <p className="mt-10 max-w-prose text-xs text-muted">
        Switching a rule on or off applies to extras posted from then on; a charge already posted keeps the tax it was posted with. Every change here, including adding a rule, is recorded with who made it.
      </p>
    </main>
  );
}
