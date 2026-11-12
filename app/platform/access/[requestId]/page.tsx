import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { EmptyState, linkClass, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { readSetup, timeLeft } from "@/lib/platform/access";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

/**
 * The read-only view an approved request opens: how the hotel group is set up, with no guest, reservation, payment, invoice, email,
 * staff name or secret in it. Only the person who asked, only while the window is open; opening it is counted and recorded.
 */
export default async function AccessView({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!z.guid().safeParse(requestId).success) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_access_view", { p_request: requestId });
  const setup = error ? null : readSetup(data);
  if (!setup) notFound();
  const left = timeLeft({ status: "approved", approved_until: setup.approved_until }, new Date());

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href="/platform/access" className={linkClass}>
          Back to access requests
        </Link>
      </p>
      <PageTitle>{setup.tenant_name}: setup</PageTitle>
      <PageIntro>
        Read only. {left ?? "The window has closed."} This view was recorded. It shows settings, never guests, payments, invoices, emails,
        staff names or secrets.
      </PageIntro>

      <section className="mt-6">
        <SectionTitle>Group</SectionTitle>
        <p className="mt-2 text-sm">Status: {setup.tenant_status}</p>
        <p className="mt-1 text-sm">Payment accounts: {setup.payment_accounts.length === 0 ? "none" : setup.payment_accounts.join(", ")}</p>
        <p className="mt-1 text-sm">
          Active people by role: {setup.roles.length === 0 ? "none" : setup.roles.map((r) => `${r.role} ${r.people}`).join(", ")}
        </p>
        <p className="mt-1 text-sm">
          Feature switches:{" "}
          {setup.features.length === 0 ? "none set (all on)" : setup.features.map((f) => `${f.key} ${f.enabled ? "on" : "off"}`).join(", ")}
        </p>
        <p className="mt-1 text-sm">
          Web addresses:{" "}
          {setup.domains.length === 0
            ? "none"
            : setup.domains.map((d) => `${d.host} (${d.verified ? "verified" : "not verified"})`).join(", ")}
        </p>
      </section>

      {setup.properties.length === 0 && <EmptyState className="mt-6">No hotels in this group yet.</EmptyState>}
      {setup.properties.map((p) => (
        <section key={p.name} className="mt-8" aria-label={p.name}>
          <h2 className="font-display text-2xl">{p.name}</h2>
          <p className="mt-1 text-sm text-muted">
            Status: {p.status}. Policy version in force: {p.policy_version ?? "none"}.
          </p>

          <SectionTitle>Room types</SectionTitle>
          {p.room_types.length === 0 ? (
            <p className="mt-2 text-sm text-muted">None.</p>
          ) : (
            <ul className="mt-2 text-sm">
              {p.room_types.map((r) => (
                <li key={r.code} className="border-b border-line py-1.5">
                  {r.name} ({r.code}): sleeps {r.max_occupancy}, from {money(r.base_rate_minor, r.currency)}, {r.status}
                  {r.public ? ", shown to guests" : ", not shown to guests"}
                </li>
              ))}
            </ul>
          )}

          <SectionTitle>Rate plans</SectionTitle>
          {p.rate_plans.length === 0 ? (
            <p className="mt-2 text-sm text-muted">None.</p>
          ) : (
            <ul className="mt-2 text-sm">
              {p.rate_plans.map((r) => (
                <li key={r.code} className="border-b border-line py-1.5">
                  {r.name} ({r.code}){r.default ? ", default" : ""}, {r.status}
                  <span className="block break-all text-xs text-muted">
                    Cancellation: {JSON.stringify(r.cancellation_policy)}. Payment: {JSON.stringify(r.payment_policy)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <SectionTitle>Tax rules</SectionTitle>
          {p.tax_rules.length === 0 ? (
            <p className="mt-2 text-sm text-muted">None.</p>
          ) : (
            <ul className="mt-2 text-sm">
              {p.tax_rules.map((t, i) => (
                <li key={i} className="border-b border-line py-1.5">
                  {t.name}: {t.rate} {t.basis === "percent" ? "%" : "per night"}, {t.status}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </main>
  );
}
