import { buttonPrimary, buttonQuiet, Notice } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { todayIn } from "@/lib/staff/reservations";
import { setExtrasTax } from "@/lib/staff/tax-actions";
import {
  appliesLine, canApplyToExtras, describeRate, extrasTaxRules, ruleState, sortRules, STATE_LABEL, TAX_RULE_COLUMNS, type TaxRuleRow,
} from "@/lib/staff/tax-rules";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Tax rules: which rules the hotel charges, and which of them also tax the extras posted to a guest's folio.
 * Nights are taxed by every rule in force; extras only by the percent rules marked here, and nothing is marked
 * until a person does it. Changing the mark affects extras posted from then on; a charge already posted keeps the
 * tax it was posted with. Only people with property.configure may change it (the database decides), and the change
 * is recorded in the audit log.
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
      <h1 className="font-display text-3xl">Tax rules</h1>
      <p className="mt-2 max-w-prose text-muted">
        Every tax rule in force is added to each night of a stay. Extras posted to a guest's folio, such as the minibar or laundry, are taxed only by the percentage rules you switch on here. Nothing is switched on until you do it, so until then extras carry no tax.
      </p>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <p role="alert" className="mb-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The tax rules could not be loaded. Reload the page.</p>}

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
                    </li>
                  );
                })}
              </ul>
            )}

            {!manage && mine.length > 0 && <p className="mt-3 text-sm text-muted">You can see these rules but not change them.</p>}
          </section>
        );
      })}

      <p className="mt-10 max-w-prose text-xs text-muted">
        Switching a rule on or off applies to extras posted from then on; a charge already posted keeps the tax it was posted with. Adding a tax rule or changing its rate is not available on this screen yet. Every change here is recorded with who made it.
      </p>
    </main>
  );
}
