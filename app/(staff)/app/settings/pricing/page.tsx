import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { applyPricingNow, deletePricingRule, savePricingLimits, savePricingRule, setPricingAutoApply } from "@/lib/staff/pricing-actions";
import {
  MAX_PRICING_RULES,
  parseAutoSettings,
  parseLimitsList,
  parseRuleList,
  parseSuggestions,
  percentText,
  RULE_KINDS,
  ruleWhenText,
  suggestionSummary,
  WEEKDAY_NAMES,
  type LimitRow,
  type RuleRow,
} from "@/lib/staff/pricing-rules";
import { minorToInput } from "@/lib/staff/money-input";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DAY_CHOICES = [7, 14, 30];

/**
 * Suggested prices from the hotel's pricing rules (migration 146), and the automatic pricing switch (migration 152). The suggestions only
 * suggest. With automatic pricing on, the maintenance job writes the suggested price of the next 60 nights into the daily rates; bookings and
 * holds already made keep their price. People with rate.view see it; rate.manage writes the rules, the limits and the switch. The database
 * decides on every save.
 */
export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const rawFrom = typeof search.from === "string" ? search.from : "";
  const today = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) && !Number.isNaN(Date.parse(`${rawFrom}T00:00:00Z`)) ? rawFrom : today;
  const daysRaw = Number(typeof search.days === "string" ? search.days : "14");
  const days = DAY_CHOICES.includes(daysRaw) ? daysRaw : 14;

  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name, currency").order("name");
  const properties = (props ?? []) as { id: string; name: string; currency: string }[];
  const results = await Promise.all(
    properties.map(async (p) => ({
      rules: await supabase.rpc("pricing_rule_list", { p_property: p.id }),
      limits: await supabase.rpc("pricing_limits_list", { p_property: p.id }),
      settings: await supabase.rpc("pricing_settings_get", { p_property: p.id }),
      suggestions: await supabase.rpc("pricing_suggestions", { p_property: p.id, p_from: from, p_days: days }),
    })),
  );
  // A hotel the person may not see answers NOT_FOUND and is left out; a flag that is off only hides the suggestions; any other failure is shown.
  const failed =
    Boolean(propError) ||
    results.some((r) =>
      [r.rules, r.limits, r.suggestions, r.settings].some((x) => x.error && !/NOT_FOUND|dynamic pricing off/.test(x.error.message)),
    );
  const many = properties.length > 1;

  return (
    <main className="max-w-5xl">
      <PageTitle>Pricing suggestions</PageTitle>
      <PageIntro>
        Rules change a night&rsquo;s current price by a percentage when the hotel is busy, when the night is close, on certain weekdays or
        during an event. Rules that match the same night add up, the result is rounded to the nearest 100 naira and then kept between the
        floor and ceiling you set for that room type. The table only suggests. Real prices change only if you switch automatic pricing on
        below; you can always set a price by hand on the rates page, and a night you set by hand is left alone.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {failed && <ErrorBanner className="mb-6">Pricing could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const r = results[i];
        if (!r || (r.rules.error && /NOT_FOUND/.test(r.rules.error.message))) return null;
        const rules = parseRuleList(r.rules.data);
        const limits = parseLimitsList(r.limits.data);
        const suggestions = parseSuggestions(r.suggestions.data);
        const auto = parseAutoSettings(r.settings.data);
        const flagOff = Boolean(r.suggestions.error && /dynamic pricing off/.test(r.suggestions.error.message));
        const money = (m: number) => formatMoney(m, p.currency);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {flagOff && (
              <ErrorBanner className="mt-4">
                Dynamic pricing is switched off for your hotel group. Your rules are kept, but nothing is suggested. Contact the platform.
              </ErrorBanner>
            )}

            {!flagOff && (
              <div className="mt-4 rounded border border-line bg-white p-4">
                <h3 className="font-display text-xl">Automatic pricing</h3>
                <p className="mt-1 text-sm">
                  <strong>{auto.auto_apply ? "On" : "Off"}</strong>
                  {auto.auto_apply
                    ? `. The next 60 nights are priced from your rules every day. ${auto.nights_managed} nights carry an automatic price${auto.nights_by_hand > 0 ? `; ${auto.nights_by_hand} you set by hand are left alone` : ""}.`
                    : ". Prices stay as you set them."}
                </p>
                {auto.auto_apply && auto.last_applied_at && (
                  <p className="mt-1 text-sm text-muted">Last applied {formatDate(auto.last_applied_at.slice(0, 10))}.</p>
                )}
                <p className="mt-1 text-sm text-muted">
                  Guests and staff see the automatic price on new quotes and bookings. A booking or hold already made keeps the price it was
                  made at. Switching off puts every night it changed back to the price it had.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <form action={setPricingAutoApply}>
                    <input type="hidden" name="propertyId" value={p.id} />
                    <input type="hidden" name="on" value={auto.auto_apply ? "0" : "1"} />
                    <PendingButton className={auto.auto_apply ? buttonQuiet : buttonPrimary} pendingLabel="Working…">
                      {auto.auto_apply ? "Switch off" : "Switch on"}
                    </PendingButton>
                  </form>
                  {auto.auto_apply && (
                    <form action={applyPricingNow}>
                      <input type="hidden" name="propertyId" value={p.id} />
                      <PendingButton className={buttonQuiet} pendingLabel="Applying…">
                        Apply my rules now
                      </PendingButton>
                    </form>
                  )}
                </div>
              </div>
            )}

            {!flagOff && (
              <div className="mt-8">
                <h3 className="font-display text-xl">Suggested prices</h3>
                <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="block text-sm" htmlFor={`from-${p.id}`}>
                    From
                    <input id={`from-${p.id}`} name="from" type="date" defaultValue={from} className={`${inputClass} mt-1`} />
                  </label>
                  <label className="block text-sm" htmlFor={`days-${p.id}`}>
                    Days
                    <select id={`days-${p.id}`} name="days" defaultValue={String(days)} className={`${inputClass} mt-1`}>
                      {DAY_CHOICES.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className={buttonQuiet}>
                    Show
                  </button>
                </form>
                {suggestions.length === 0 && (
                  <p className="mt-4 text-sm text-muted">No room types with a price yet. Set prices on the rates page first.</p>
                )}
                {suggestions.map((t) => {
                  const sum = suggestionSummary(t.nights);
                  return (
                    <div key={t.room_type_id} className="mt-6">
                      <h4 className="font-medium">{t.room_type_name}</h4>
                      <p className="text-sm text-muted">
                        {t.nights.length === 0
                          ? "No nights in this range have a price."
                          : sum.changed === 0
                            ? "No change suggested for these nights."
                            : `${sum.changed} of ${t.nights.length} nights would change${sum.up > 0 ? `, up to +${sum.up}%` : ""}${sum.down < 0 ? `, down to ${sum.down}%` : ""}.`}
                      </p>
                      {t.nights.length > 0 && (
                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full text-sm">
                            <caption className="sr-only">Suggested prices for {t.room_type_name}</caption>
                            <thead>
                              <tr className="border-b border-line text-left">
                                <th scope="col" className="py-2 pr-3 font-medium">
                                  Night
                                </th>
                                <th scope="col" className="py-2 pr-3 text-right font-medium">
                                  Now
                                </th>
                                <th scope="col" className="py-2 pr-3 text-right font-medium">
                                  Suggested
                                </th>
                                <th scope="col" className="py-2 pr-3 text-right font-medium">
                                  Change
                                </th>
                                <th scope="col" className="py-2 pr-3 text-right font-medium">
                                  Taken
                                </th>
                                <th scope="col" className="py-2 font-medium">
                                  Why
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {t.nights.map((n) => {
                                const changed = n.suggested_minor !== n.current_minor;
                                return (
                                  <tr key={n.night} className="border-b border-line">
                                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                                      {formatDate(n.night)}
                                    </th>
                                    <td className="py-2 pr-3 text-right tabular-nums">
                                      {money(n.current_minor)}
                                      {n.auto && <span className="block text-xs text-muted">automatic, was {money(n.base_minor)}</span>}
                                    </td>
                                    <td className={`py-2 pr-3 text-right tabular-nums ${changed ? "font-medium" : "text-muted"}`}>
                                      {money(n.suggested_minor)}
                                    </td>
                                    <td className="py-2 pr-3 text-right tabular-nums">
                                      {changed
                                        ? percentText(Math.round(((n.suggested_minor - n.current_minor) * 1000) / n.current_minor) / 10)
                                        : "None"}
                                    </td>
                                    <td className="py-2 pr-3 text-right tabular-nums">
                                      {n.occupancy_percent === null ? "None" : `${n.occupancy_percent}%`}
                                    </td>
                                    <td className="py-2 text-muted">
                                      {n.rules.length > 0 ? n.rules.join(", ") : "No rule matches"}
                                      {n.limited ? ` (held at the ${n.limited})` : ""}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-10">
              <h3 className="font-display text-xl">Floor and ceiling</h3>
              <p className="mt-1 text-sm text-muted">
                A suggestion is never below the floor or above the ceiling. Leave both empty for no limit.
              </p>
              <ul className="mt-3 space-y-3">
                {limits.map((l) => (
                  <li key={l.room_type_id} className="rounded border border-line bg-white p-4">
                    <LimitsForm propertyId={p.id} limit={l} currency={p.currency} />
                  </li>
                ))}
              </ul>
              {limits.length === 0 && <p className="mt-3 text-sm text-muted">No room types yet.</p>}
            </div>

            <div className="mt-10">
              <h3 className="font-display text-xl">Rules</h3>
              <ul className="mt-3 space-y-4">
                {rules.map((rule) => (
                  <li key={rule.id} className="rounded border border-line bg-white p-4">
                    <p className="text-sm">
                      <strong>{rule.name}</strong> · {ruleWhenText(rule, formatDate)} · {percentText(rule.adjust_percent)} ·{" "}
                      {rule.room_type_name ?? "all room types"} · {rule.is_active ? "switched on" : "switched off"}
                    </p>
                    <RuleForm propertyId={p.id} rule={rule} limits={limits} />
                    <form action={deletePricingRule} className="mt-2">
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <PendingButton className={buttonQuiet} pendingLabel="Deleting…">
                        Delete this rule
                      </PendingButton>
                    </form>
                  </li>
                ))}
              </ul>
              {rules.length === 0 && <p className="mt-3 text-sm text-muted">No rules yet.</p>}
              {rules.length < MAX_PRICING_RULES && (
                <div className="mt-6 rounded border border-dashed border-line bg-white p-4">
                  <h4 className="text-sm font-medium">Add a rule</h4>
                  <RuleForm propertyId={p.id} rule={null} limits={limits} />
                </div>
              )}
            </div>
          </section>
        );
      })}
    </main>
  );
}

function LimitsForm({ propertyId, limit, currency }: { propertyId: string; limit: LimitRow; currency: string }) {
  const id = limit.room_type_id;
  return (
    <form action={savePricingLimits} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="roomTypeId" value={id} />
      <p className="text-sm">
        <strong>{limit.room_type_name}</strong>
        <span className="block text-muted">Base price {formatMoney(limit.base_rate_minor, currency)}</span>
      </p>
      <label className="block text-sm" htmlFor={`fl-${id}`}>
        Floor
        <input
          id={`fl-${id}`}
          name="floor"
          inputMode="decimal"
          placeholder="None"
          defaultValue={limit.floor_minor ? minorToInput(limit.floor_minor) : ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm" htmlFor={`ce-${id}`}>
        Ceiling
        <input
          id={`ce-${id}`}
          name="ceiling"
          inputMode="decimal"
          placeholder="None"
          defaultValue={limit.ceiling_minor ? minorToInput(limit.ceiling_minor) : ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <PendingButton className={buttonQuiet} pendingLabel="Saving…">
        Save
      </PendingButton>
    </form>
  );
}

function RuleForm({ propertyId, rule, limits }: { propertyId: string; rule: RuleRow | null; limits: LimitRow[] }) {
  const id = rule?.id ?? "new";
  return (
    <form action={savePricingRule} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="ruleId" value={rule?.id ?? ""} />
      <label className="block text-sm" htmlFor={`n-${id}`}>
        Name
        <input
          id={`n-${id}`}
          name="name"
          required
          maxLength={60}
          defaultValue={rule?.name ?? ""}
          placeholder="Weekend uplift"
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm" htmlFor={`pc-${id}`}>
        Change in percent (-50 to 100)
        <input
          id={`pc-${id}`}
          name="percent"
          required
          inputMode="decimal"
          defaultValue={rule ? String(rule.adjust_percent) : ""}
          placeholder="10 or -5"
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm" htmlFor={`k-${id}`}>
        Applies when
        <select id={`k-${id}`} name="kind" defaultValue={rule?.kind ?? "weekday"} className={`${inputClass} mt-1`}>
          {RULE_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm" htmlFor={`rt-${id}`}>
        Room type
        <select id={`rt-${id}`} name="roomTypeId" defaultValue={rule?.room_type_id ?? ""} className={`${inputClass} mt-1`}>
          <option value="">All room types</option>
          {limits.map((l) => (
            <option key={l.room_type_id} value={l.room_type_id}>
              {l.room_type_name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="text-sm sm:col-span-2">
        <legend>Fill in the fields for the kind you chose</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="flex items-end gap-2">
            <label className="block" htmlFor={`bf-${id}`}>
              From (percent taken, or days)
              <input
                id={`bf-${id}`}
                name="from"
                type="number"
                min={0}
                max={365}
                step={1}
                defaultValue={rule?.band_from ?? ""}
                className={`${inputClass} mt-1 w-24`}
              />
            </label>
            <label className="block" htmlFor={`bt-${id}`}>
              To
              <input
                id={`bt-${id}`}
                name="to"
                type="number"
                min={0}
                max={365}
                step={1}
                defaultValue={rule?.band_to ?? ""}
                className={`${inputClass} mt-1 w-24`}
              />
            </label>
          </div>
          <div className="flex items-end gap-2">
            <label className="block" htmlFor={`df-${id}`}>
              Event from
              <input id={`df-${id}`} name="dateFrom" type="date" defaultValue={rule?.date_from ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block" htmlFor={`dt-${id}`}>
              Event to
              <input id={`dt-${id}`} name="dateTo" type="date" defaultValue={rule?.date_to ?? ""} className={`${inputClass} mt-1`} />
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3" role="group" aria-label="Weekdays">
          {WEEKDAY_NAMES.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input
                type="checkbox"
                name={`day${i + 1}`}
                defaultChecked={rule?.weekdays.includes(i + 1) ?? false}
                className="accent-primary"
              />
              {d}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm sm:col-span-2" htmlFor={`a-${id}`}>
        <input id={`a-${id}`} name="active" type="checkbox" defaultChecked={rule ? rule.is_active : true} className="accent-primary" />
        Switched on
      </label>
      <div className="sm:col-span-2">
        <PendingButton className={buttonPrimary} pendingLabel="Working…">
          {rule ? "Save rule" : "Add rule"}
        </PendingButton>
      </div>
    </form>
  );
}
