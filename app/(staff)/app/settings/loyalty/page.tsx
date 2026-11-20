import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDate } from "@/lib/guest-site/format";
import { adjustLoyaltyPoints, saveLoyaltyPointsSettings } from "@/lib/staff/loyalty-actions";
import { KIND_LABEL, parseLedger, parseSettingsRow, pointsText } from "@/lib/staff/loyalty";
import { minorToInput } from "@/lib/staff/money-input";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Loyalty points settings (migration 159): the switch, the earn rate, what a point is worth, the least that can be spent, manual
 * adjustments and the history. People with property.configure see and change it; the database decides on every save. Points are spent
 * from the booking page.
 */
export default async function LoyaltyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const rawEmail = typeof search.email === "string" ? search.email.trim().slice(0, 254) : "";

  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name").order("name");
  const properties = (props ?? []) as { id: string; name: string }[];
  const results = await Promise.all(
    properties.map(async (p) => ({
      settings: await supabase.rpc("loyalty_settings_get", { p_property: p.id }),
      ledger: await supabase.rpc("loyalty_ledger_list", { p_property: p.id, p_email: rawEmail || undefined, p_limit: 50 }),
    })),
  );
  // A hotel the person may not configure answers NOT_FOUND and is left out; a mistyped filter e-mail is shown as such; any other failure is shown.
  const failed =
    Boolean(propError) ||
    results.some((r) => r.settings.error && !/NOT_FOUND/.test(r.settings.error.message)) ||
    results.some((r) => r.ledger.error && !/NOT_FOUND|POLICY_VIOLATION: email/.test(r.ledger.error.message));
  const badFilter = results.some((r) => r.ledger.error && /POLICY_VIOLATION: email/.test(r.ledger.error.message));
  const many = properties.length > 1;

  return (
    <main className="max-w-5xl">
      <PageTitle>Loyalty points</PageTitle>
      <PageIntro>
        A guest earns points on the room price of a stay when it is checked out (not on tax or extras, and never on a cancelled or no-show
        booking). Staff spend points as the discount on a later booking from the booking page. One account per hotel group and e-mail
        address. Points have no expiry and no tiers yet. It is off until you switch it on, and needs loyalty points in your hotel
        group&rsquo;s plan.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {failed && <ErrorBanner className="mb-6">Loyalty settings could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const r = results[i];
        if (!r || (r.settings.error && /NOT_FOUND/.test(r.settings.error.message))) return null;
        const s = parseSettingsRow(r.settings.data);
        const ledger = parseLedger(r.ledger.data);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {s && !s.flag_on && (
              <ErrorBanner className="mt-4">
                Loyalty points are not included in your hotel group&rsquo;s plan, so nothing here can be saved. Contact the platform.
              </ErrorBanner>
            )}

            {s && (
              <form action={saveLoyaltyPointsSettings} className="mt-4 grid gap-3 rounded border border-line bg-white p-4 sm:grid-cols-3">
                <input type="hidden" name="propertyId" value={p.id} />
                <label className="flex items-center gap-2 text-sm sm:col-span-3" htmlFor={`en-${p.id}`}>
                  <input id={`en-${p.id}`} name="enabled" type="checkbox" defaultChecked={s.enabled} className="accent-primary" />
                  Loyalty points are on at this hotel
                </label>
                <label className="block text-sm" htmlFor={`ea-${p.id}`}>
                  Points earned for every 100 naira of room price (1 to 50)
                  <input
                    id={`ea-${p.id}`}
                    name="earnPer100"
                    required
                    inputMode="numeric"
                    defaultValue={s.earn_per_100}
                    className={`${inputClass} mt-1`}
                  />
                </label>
                <label className="block text-sm" htmlFor={`pv-${p.id}`}>
                  What one point is worth, in naira (0.10 to 100)
                  <input
                    id={`pv-${p.id}`}
                    name="pointValue"
                    required
                    inputMode="decimal"
                    defaultValue={minorToInput(s.point_value_minor)}
                    className={`${inputClass} mt-1`}
                  />
                </label>
                <label className="block text-sm" htmlFor={`mr-${p.id}`}>
                  Fewest points that can be spent (1 to 10,000)
                  <input
                    id={`mr-${p.id}`}
                    name="minRedeem"
                    required
                    inputMode="numeric"
                    defaultValue={s.min_redeem}
                    className={`${inputClass} mt-1`}
                  />
                </label>
                <div className="sm:col-span-3">
                  <PendingButton className={buttonPrimary} pendingLabel="Saving…">
                    Save settings
                  </PendingButton>
                </div>
              </form>
            )}

            <div className="mt-8">
              <h3 className="font-display text-xl">Adjust a guest&rsquo;s points</h3>
              <form
                action={adjustLoyaltyPoints}
                className="mt-3 grid gap-3 rounded border border-dashed border-line bg-white p-4 sm:grid-cols-4"
              >
                <input type="hidden" name="propertyId" value={p.id} />
                <label className="block text-sm sm:col-span-2" htmlFor={`ae-${p.id}`}>
                  Guest e-mail address
                  <input id={`ae-${p.id}`} name="email" type="email" required className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm" htmlFor={`ad-${p.id}`}>
                  Direction
                  <select id={`ad-${p.id}`} name="direction" defaultValue="add" className={`${inputClass} mt-1`}>
                    <option value="add">Add points</option>
                    <option value="remove">Remove points</option>
                  </select>
                </label>
                <label className="block text-sm" htmlFor={`ap-${p.id}`}>
                  Points (1 to 100,000)
                  <input id={`ap-${p.id}`} name="points" required inputMode="numeric" className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm sm:col-span-3" htmlFor={`ar-${p.id}`}>
                  Reason
                  <input
                    id={`ar-${p.id}`}
                    name="reason"
                    required
                    maxLength={200}
                    placeholder="Apology for a noisy room"
                    className={`${inputClass} mt-1`}
                  />
                </label>
                <div className="sm:self-end">
                  <PendingButton className={buttonQuiet} pendingLabel="Saving…">
                    Adjust
                  </PendingButton>
                </div>
              </form>
            </div>

            <div className="mt-8">
              <h3 className="font-display text-xl">History</h3>
              <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
                <label className="block text-sm" htmlFor={`fe-${p.id}`}>
                  Only this e-mail address
                  <input id={`fe-${p.id}`} name="email" type="email" defaultValue={rawEmail} className={`${inputClass} mt-1`} />
                </label>
                <button type="submit" className={buttonQuiet}>
                  Show
                </button>
              </form>
              {badFilter && <p className="mt-2 text-sm text-critical">That is not a valid e-mail address.</p>}
              {ledger.length === 0 ? (
                <p className="mt-3 text-sm text-muted">No points movements yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Latest points movements at {p.name}</caption>
                    <thead>
                      <tr className="border-b border-line text-left">
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Date
                        </th>
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Guest
                        </th>
                        <th scope="col" className="py-2 pr-3 font-medium">
                          What
                        </th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">
                          Points
                        </th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">
                          Balance now
                        </th>
                        <th scope="col" className="py-2 font-medium">
                          Why
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((l) => (
                        <tr key={l.id} className="border-b border-line">
                          <td className="py-2 pr-3">{formatDate(l.created_at.slice(0, 10))}</td>
                          <td className="py-2 pr-3">{l.email}</td>
                          <td className="py-2 pr-3">{KIND_LABEL[l.kind]}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {l.points > 0 ? "+" : ""}
                            {pointsText(l.points)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{pointsText(l.balance)}</td>
                          <td className="py-2 text-muted">{l.booking_reference ? `Booking ${l.booking_reference}` : (l.reason ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </main>
  );
}
