import { buttonPrimary, Notice, StatusChip } from "@/components/staff/ui";
import { createMailer } from "@/lib/email/mailer";
import { resendEmail } from "@/lib/staff/email-actions";
import { canOfferResend, errorAdvice, holdEnded, kindLabel, splitEmails, type FailedEmail } from "@/lib/staff/emails";
import { formatDateTime } from "@/lib/staff/format";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function EmailsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();

  const listQ = await supabase.rpc("staff_failed_emails", { p_limit: 100 });
  const rows = (listQ.data ?? []) as FailedEmail[];

  const propertyIds = [...new Set(rows.map((r) => r.property_id))];
  const [propQ, ...permQ] = await Promise.all([
    propertyIds.length ? supabase.from("properties").select("id, name, timezone").in("id", propertyIds) : Promise.resolve({ data: [] }),
    ...propertyIds.map((id) => supabase.rpc("has_permission", { p_property: id, p_permission: "reservation.modify" })),
  ]);
  const properties = new Map(((propQ.data ?? []) as { id: string; name: string; timezone: string }[]).map((p) => [p.id, p]));
  const canModify = new Map(propertyIds.map((id, i) => [id, permQ[i]?.data === true]));
  const showProperty = properties.size > 1;
  const { failed, retrying } = splitEmails(rows);
  const mailConfigured = createMailer() !== null;

  function Row({ e }: { e: FailedEmail }) {
    const prop = properties.get(e.property_id);
    const tz = prop?.timezone ?? "UTC";
    const advice = errorAdvice(e.last_error);
    const offer = canOfferResend(e, canModify.get(e.property_id) === true);
    return (
      <li className="grid gap-x-8 gap-y-3 border-b border-line py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{kindLabel(e.kind)}</span>
            <StatusChip status={e.state === "failed" ? "failed" : "processing"} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {e.booking_reference}, to {e.to_email}{showProperty && prop ? `, ${prop.name}` : ""}
          </p>
          {e.last_error && <p className="mt-2 max-w-prose break-words text-sm text-critical">{e.last_error}</p>}
          {advice && <p className="mt-1 max-w-prose text-sm">{advice}</p>}
          <p className="mt-1 text-xs text-muted">
            {e.state === "failed"
              ? `Gave up after ${e.attempts} attempts, last tried ${formatDateTime(e.updated_at, tz)}.`
              : `Attempt ${e.attempts} failed ${formatDateTime(e.updated_at, tz)}. Trying again ${formatDateTime(e.next_attempt_at, tz)}.`}
          </p>
        </div>
        <div className="md:justify-self-end">
          {offer && (
            <form action={resendEmail}>
              <input type="hidden" name="emailId" value={e.id} />
              <button type="submit" className={buttonPrimary}>Send again</button>
            </form>
          )}
          {e.state === "failed" && holdEnded(e) && (
            <p className="max-w-xs text-sm text-muted">The room is no longer on hold, so this email would now be wrong. It cannot be resent.</p>
          )}
          {e.state === "failed" && !holdEnded(e) && !offer && (
            <p className="max-w-xs text-sm text-muted">You can see this email but not resend it. Ask someone who can modify reservations.</p>
          )}
          {e.state === "retrying" && <p className="max-w-xs text-sm text-muted">Retrying by itself. Nothing to do yet.</p>}
        </div>
      </li>
    );
  }

  function Section({ title, hint, items }: { title: string; hint?: string; items: FailedEmail[] }) {
    if (items.length === 0) return null;
    return (
      <section className="mt-10 first:mt-0">
        <h2 className="font-display text-xl">{title} <span className="text-base text-muted">({items.length})</span></h2>
        {hint && <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
        <ul className="mt-2 border-t border-line">{items.map((e) => <Row key={e.id} e={e} />)}</ul>
      </section>
    );
  }

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Guest emails</h1>
      <p className="mt-2 max-w-prose text-muted">
        Emails to guests that could not be delivered. The system retries a few times by itself; the ones that gave up are listed first, and you can send them again.
      </p>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
        {listQ.error && <p role="alert" className="mb-5 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The list could not be loaded. Reload the page.</p>}
        {!mailConfigured && (
          <p className="mb-5 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">
            Email sending is not set up on this server (no mail provider key or sender address), so emails wait in the queue and resending will not deliver anything until it is.
          </p>
        )}
      </div>

      {!listQ.error && rows.length === 0 && <p className="rounded border border-line bg-white px-4 py-6 text-muted">No failed or retrying guest emails.</p>}

      <Section title="Gave up" hint="Five attempts failed. Check the reason, fix it if it is something on our side, then send again." items={failed} />
      <Section title="Still retrying" items={retrying} />
    </main>
  );
}
