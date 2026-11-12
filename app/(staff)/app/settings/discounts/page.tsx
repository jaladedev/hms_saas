import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import {
  buildCaps,
  capSummary,
  percentInput,
  percentText,
  type DefaultCap,
  type OverrideCap,
  type RoleName,
} from "@/lib/staff/discount-caps";
import { setDiscountCap } from "@/lib/staff/discount-cap-actions";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

/**
 * Discount limits: how large a discount each role may give on a booking at this hotel. Each role has a standard limit set by
 * the platform; the owner can give this hotel's own limit instead, higher or lower (0 means the role cannot discount), and
 * put it back to the standard at any time. Only the owner may change it (the database decides, `staff.manage`), so a general
 * manager can see their own limit but cannot raise it. Every change is in the setup history. A limit applies to discounts
 * given from then on; a discount already on a booking stays as it is.
 */
export default async function DiscountLimitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, defQ, ovQ, roleQ] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase.from("discount_caps").select("role_key, max_percent"),
    supabase.from("discount_cap_overrides").select("property_id, role_key, max_percent"),
    supabase.from("roles").select("key, name"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const defaults = (defQ.data ?? []) as DefaultCap[];
  const overrides = (ovQ.data ?? []) as OverrideCap[];
  const roles = (roleQ.data ?? []) as RoleName[];
  const loadError = Boolean(propQ.error || defQ.error || ovQ.error || roleQ.error);

  const canManage = new Map<string, boolean>();
  await Promise.all(
    properties.map(async (p) => {
      const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "staff.manage" });
      canManage.set(p.id, data === true);
    }),
  );
  const many = properties.length > 1;

  return (
    <main className="max-w-3xl">
      <PageTitle>Discount limits</PageTitle>
      <PageIntro>
        How large a discount each role may give on a booking, as a share of the booking&rsquo;s price. A discount can only be given before
        anything is paid on the booking. Only the owner can change these limits.
      </PageIntro>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {loadError && <ErrorBanner className="mb-6">The limits could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const caps = buildCaps(p.id, defaults, overrides, roles);
        const manage = canManage.get(p.id) === true;
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {caps.length === 0 ? (
              <p className="mt-4 text-muted">No role can give discounts yet.</p>
            ) : (
              <ul className="mt-4 divide-y divide-line border-y border-line">
                {caps.map((c) => (
                  <li key={c.roleKey} className="py-4">
                    <p className="font-medium">
                      {c.name} <span className="tabular-nums text-muted">{percentText(c.percent)}</span>
                      {c.source === "override" && (
                        <span className="ml-2 rounded border border-primary/40 px-1.5 py-0.5 text-xs font-normal text-primary-strong">
                          Set for this hotel
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {c.source === "override" ? `Standard limit is ${percentText(c.defaultPercent)}. ` : "Standard limit. "}A{" "}
                      {c.name.toLowerCase()} {capSummary(c)}.
                    </p>
                    {manage && (
                      <form action={setDiscountCap} className="mt-3 flex flex-wrap items-end gap-3">
                        <input type="hidden" name="property" value={p.id} />
                        <input type="hidden" name="role" value={c.roleKey} />
                        <div>
                          <label htmlFor={`cap-${p.id}-${c.roleKey}`} className="block text-sm">
                            Limit for {c.name.toLowerCase()} (%)
                          </label>
                          <input
                            id={`cap-${p.id}-${c.roleKey}`}
                            name="percent"
                            required
                            inputMode="decimal"
                            defaultValue={percentInput(c.percent)}
                            className={`${inputClass} w-28`}
                          />
                        </div>
                        <PendingButton className={buttonPrimary} pendingLabel="Saving…">
                          Save
                        </PendingButton>
                        {c.source === "override" && (
                          <button type="submit" name="reset" value="1" formNoValidate className={buttonQuiet}>
                            Use the standard limit
                          </button>
                        )}
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!manage && <p className="mt-3 text-sm text-muted">Only the owner can change these limits.</p>}
          </section>
        );
      })}
    </main>
  );
}
