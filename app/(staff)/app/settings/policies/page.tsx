import { buttonPrimary, inputClass, Notice, ErrorBanner, PageIntro } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { MAX_RULES, POLICY_COLUMNS, CHARGE_LABEL, describeWindow, guestSummary, readConfig, versionsOn, type PolicyRow } from "@/lib/staff/policies";
import { minorToInput } from "@/lib/staff/money-input";
import { publishPolicy } from "@/lib/staff/policy-actions";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Cancellation and payment policies. A policy is versioned: saving publishes a new version that starts on a date
 * (today or later), and bookings made from then on follow it. A booking copies the policy into its own snapshot
 * when it is made, so a new version never changes a booking that already exists. Only people with
 * property.configure may publish (the database decides).
 */
export default async function PoliciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const now = new Date();
  const [propQ, polQ] = await Promise.all([
    supabase.from("properties").select("id, name, timezone").order("name"),
    supabase.from("property_policies").select(POLICY_COLUMNS).limit(500),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const policies = (polQ.data ?? []) as PolicyRow[];
  const loadError = Boolean(propQ.error || polQ.error);

  const canConfigure = new Map<string, boolean>();
  await Promise.all(properties.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "property.configure" });
    canConfigure.set(p.id, data === true);
  }));
  const many = properties.length > 1;
  const naira = (m: number) => formatMoney(m, "NGN");

  return (
    <main className="max-w-4xl">
      <h1 className="font-display text-3xl">Cancellation and payment policies</h1>
      <PageIntro>
        These rules apply to bookings made from the date a policy starts. A booking keeps the policy it was made under, so saving a new one never changes a booking that already exists.
      </PageIntro>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <ErrorBanner className="mb-6">The policies could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const mine = policies.filter((x) => x.property_id === p.id);
        const today = todayIn(p.timezone, now);
        const { current, upcoming, nextVersion } = versionsOn(mine, today);
        const inForce = current === null ? null : mine.find((x) => x.version === current) ?? null;
        const cfg = readConfig(inForce?.config);
        const manage = canConfigure.get(p.id) === true;
        const slots = Math.min(MAX_RULES, cfg.cancellation_rules.length + 2);
        const deposit = cfg.online_payment.mode === "deposit_percent" ? cfg.online_payment.value : 30;

        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            <p className="mt-3 text-sm" aria-live="polite">
              {inForce
                ? <><span className="font-medium">Version {inForce.version} is in force</span> <span className="text-muted">since {formatDate(inForce.effective_from)}.</span></>
                : <><span className="font-medium">No policy is in force.</span> <span className="text-muted">Until one starts, online bookings take the full amount and cancelling is free.</span></>}
              {upcoming !== null && <> <span className="text-muted">Version {upcoming} is scheduled.</span></>}
            </p>

            <div className="mt-4 border-l-4 border-primary/40 bg-white px-4 py-3">
              <p className="text-sm font-medium">What guests read</p>
              <ul className="mt-1 space-y-1 text-sm">
                {guestSummary(cfg, naira).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>

            {manage ? (
              <form action={publishPolicy} className="mt-6 space-y-8">
                <input type="hidden" name="propertyId" value={p.id} />

                <fieldset>
                  <legend className="font-display text-xl">Cancellation rules</legend>
                  <p className="mt-1 max-w-prose text-sm text-muted">
                    The rule with the smallest window that still covers the time left before check-in applies. If none does, cancelling is free. Leave a row empty to skip it. The charge never goes above the booking total.
                  </p>
                  <div className="mt-3 divide-y divide-line border-y border-line">
                    {Array.from({ length: slots }).map((_, i) => {
                      const r = cfg.cancellation_rules[i];
                      const value = r ? (r.charge.type === "fixed" ? minorToInput(r.charge.value) : String(Number.parseFloat(r.charge.value.toFixed(4)))) : "";
                      return (
                        <div key={i} className="grid gap-3 py-3 sm:grid-cols-3">
                          <div>
                            <label htmlFor={`rh-${p.id}-${i}`} className="block text-sm">Within (hours)</label>
                            <input id={`rh-${p.id}-${i}`} name={`rule_hours_${i}`} inputMode="numeric" defaultValue={r ? String(r.within_hours) : ""} className={`${inputClass} tabular-nums`} />
                            {r && <p className="mt-1 text-xs text-muted">{describeWindow(r.within_hours)}</p>}
                          </div>
                          <div>
                            <label htmlFor={`rt-${p.id}-${i}`} className="block text-sm">Charge</label>
                            <select id={`rt-${p.id}-${i}`} name={`rule_type_${i}`} defaultValue={r?.charge.type ?? "percent"} className={inputClass}>
                              {(Object.keys(CHARGE_LABEL) as (keyof typeof CHARGE_LABEL)[]).map((t) => <option key={t} value={t}>{CHARGE_LABEL[t]}</option>)}
                            </select>
                          </div>
                          <div>
                            <label htmlFor={`rv-${p.id}-${i}`} className="block text-sm">Value (%, nights or ₦)</label>
                            <input id={`rv-${p.id}-${i}`} name={`rule_value_${i}`} inputMode="decimal" defaultValue={value} className={`${inputClass} tabular-nums`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-muted">To add more rows, save, then reload: two empty rows are always offered.</p>
                </fieldset>

                <fieldset>
                  <legend className="font-display text-xl">Payment</legend>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`om-${p.id}`} className="block text-sm">Online payment</label>
                      <select id={`om-${p.id}`} name="onlineMode" defaultValue={cfg.online_payment.mode} className={inputClass}>
                        <option value="full">Guest pays the full amount</option>
                        <option value="deposit_percent">Guest pays a deposit</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`dp-${p.id}`} className="block text-sm">Deposit (%), used when a deposit is chosen</label>
                      <input id={`dp-${p.id}`} name="depositPercent" inputMode="decimal" defaultValue={String(deposit)} className={`${inputClass} tabular-nums`} />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor={`gc-${p.id}`} className="block text-sm">Guests cancelling online</label>
                      <select id={`gc-${p.id}`} name="guestCancellation" defaultValue={cfg.guest_cancellation} className={inputClass}>
                        <option value="on">Guests can cancel from their booking link</option>
                        <option value="off">Guests must contact the hotel to cancel</option>
                      </select>
                      <p className="mt-1 text-xs text-muted">This applies as soon as the version starts, to bookings already made too. Staff can always cancel. The charge a guest would pay still follows the rules they booked under.</p>
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor={`cp-${p.id}`} className="block text-sm">Before check-in</label>
                      <select id={`cp-${p.id}`} name="checkinPayment" defaultValue={cfg.checkin_payment} className={inputClass}>
                        <option value="none">The balance can be paid at the desk</option>
                        <option value="full">The booking must be fully paid first</option>
                      </select>
                      <p className="mt-1 text-xs text-muted">With full payment required, check-in is refused until the booking is paid, unless someone with payment.verify overrides it.</p>
                    </div>
                  </div>
                </fieldset>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`ef-${p.id}`} className="block text-sm">Starts on (today or later)</label>
                    <input id={`ef-${p.id}`} name="effectiveFrom" type="date" required min={today} defaultValue={today} className={inputClass} />
                  </div>
                  <p className="self-end text-xs text-muted">Saving publishes version {nextVersion}. Versions are never edited, so the old ones stay on record.</p>
                </div>

                <button type="submit" className={buttonPrimary}>Publish version {nextVersion}</button>
              </form>
            ) : (
              <p className="mt-6 text-sm text-muted">You can read these policies but not change them. Changing them needs permission to configure the property.</p>
            )}

            {mine.length > 0 && (
              <details className="mt-8">
                <summary className="cursor-pointer text-sm font-medium text-primary-strong">Earlier versions</summary>
                <ul className="mt-3 divide-y divide-line border-y border-line text-sm">
                  {[...mine].sort((a, b) => b.version - a.version).map((x) => (
                    <li key={x.id} className="py-3">
                      <span className="font-medium">Version {x.version}</span> <span className="text-muted">from {formatDate(x.effective_from)}</span>
                      <ul className="mt-1 space-y-0.5 text-muted">{guestSummary(readConfig(x.config), naira).map((line) => <li key={line}>{line}</li>)}</ul>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
    </main>
  );
}
