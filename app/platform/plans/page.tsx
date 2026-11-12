import Link from "next/link";
import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, inputClass, PageTitle, SectionTitle } from "@/components/staff/ui";
import { PlatformNotice } from "@/components/platform-notice";
import { savePlan } from "@/lib/platform/actions";
import { planPriceLabel } from "@/lib/platform/hotel";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type Plan = {
  code: string;
  name: string;
  description: string | null;
  monthly_price_minor: number;
  currency: string;
  features: string[];
  price_is_placeholder: boolean;
  active: boolean;
  groups: number;
};

const ENFORCED = [
  "reports.export",
  "online_payments",
  "discounts",
  "online_booking",
  "guest_cancel",
  "guest_changes",
  "early_checkin",
  "housekeeping",
  "maintenance",
  "audit_log",
  "branding",
];

function PlanForm({ plan, admin }: { plan?: Plan; admin: boolean }) {
  const id = plan?.code ?? "new";
  return (
    <form action={savePlan} className="mt-3 grid gap-3 md:grid-cols-2">
      <div>
        <label htmlFor={`code-${id}`} className="block text-sm">
          Plan code
        </label>
        <input
          id={`code-${id}`}
          name="code"
          required
          maxLength={40}
          defaultValue={plan?.code ?? ""}
          readOnly={!!plan}
          disabled={!admin}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`name-${id}`} className="block text-sm">
          Name
        </label>
        <input
          id={`name-${id}`}
          name="name"
          required
          maxLength={60}
          defaultValue={plan?.name ?? ""}
          disabled={!admin}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`price-${id}`} className="block text-sm">
          Price a month (naira)
        </label>
        <input
          id={`price-${id}`}
          name="price"
          required
          inputMode="decimal"
          defaultValue={plan ? String(plan.monthly_price_minor / 100) : ""}
          disabled={!admin}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`active-${id}`} className="block text-sm">
          Can be applied to a hotel group
        </label>
        <select
          id={`active-${id}`}
          name="active"
          defaultValue={plan?.active === false ? "false" : "true"}
          disabled={!admin}
          className={inputClass}
        >
          <option value="true">Yes</option>
          <option value="false">No (retired)</option>
        </select>
      </div>
      <div className="md:col-span-2">
        <label htmlFor={`desc-${id}`} className="block text-sm">
          Description
        </label>
        <input
          id={`desc-${id}`}
          name="description"
          maxLength={300}
          defaultValue={plan?.description ?? ""}
          disabled={!admin}
          className={`${inputClass} w-full`}
        />
      </div>
      <div className="md:col-span-2">
        <label htmlFor={`features-${id}`} className="block text-sm">
          Features it turns on (separated by commas or spaces)
        </label>
        <input
          id={`features-${id}`}
          name="features"
          defaultValue={plan?.features.join(", ") ?? ""}
          disabled={!admin}
          className={`${inputClass} w-full`}
        />
      </div>
      {admin && (
        <div className="md:col-span-2">
          <PendingButton className={plan ? buttonQuiet : buttonPrimary} pendingLabel="Working…">
            {plan ? "Save plan" : "Add plan"}
          </PendingButton>
        </div>
      )}
    </form>
  );
}

export default async function PlansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [{ data, error }, level] = await Promise.all([supabase.rpc("platform_list_plans"), supabase.rpc("platform_level")]);
  const admin = level.data === "admin";
  const plans = (data ?? []) as unknown as Plan[];

  return (
    <main className="max-w-4xl space-y-8">
      <div>
        <PageTitle>Plans</PageTitle>
        <p className="mt-2 max-w-prose text-sm text-muted">
          What each plan is called, costs and includes. Nothing here charges a hotel: it records the plan. Putting a hotel group on a plan
          (from the hotel&apos;s own page) sets its plan code and turns the eleven enforced flags on or off to match: {ENFORCED.join(", ")}.
          Other feature keys are kept in the list but switch nothing. Prices marked placeholder were set when the catalog was created and
          are not decided: save the plan to confirm one.
        </p>
      </div>
      <PlatformNotice search={search} />
      {error && <ErrorBanner>The plans could not be loaded. Try again in a moment.</ErrorBanner>}
      {!error && plans.length === 0 && <EmptyState>No plans yet.</EmptyState>}

      {plans.map((p) => (
        <section key={p.code} aria-labelledby={`plan-${p.code}`} className="border-t border-line pt-5">
          <SectionTitle id={`plan-${p.code}`}>
            {p.name} <span className="text-sm font-normal text-muted">({p.code})</span>
          </SectionTitle>
          <p className="mt-1 text-sm text-muted">
            {planPriceLabel(p.monthly_price_minor, p.currency, p.price_is_placeholder)} · {p.active ? "available" : "retired"} · {p.groups}{" "}
            {p.groups === 1 ? "hotel group" : "hotel groups"} on it
          </p>
          <PlanForm plan={p} admin={admin} />
        </section>
      ))}

      {admin && (
        <section aria-labelledby="plan-new" className="border-t border-line pt-5">
          <SectionTitle id="plan-new">Add a plan</SectionTitle>
          <PlanForm admin={admin} />
        </section>
      )}
      <p className="text-sm">
        <Link href="/platform" className="underline underline-offset-2">
          Back to hotels
        </Link>
      </p>
    </main>
  );
}
