import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PlatformNotice } from "@/components/platform-notice";
import { buttonPrimary, buttonQuiet, inputClass, linkClass, PageTitle, SectionTitle } from "@/components/staff/ui";
import { addTicketNote, setTicketStatus } from "@/lib/platform/actions";
import { shortDate } from "@/lib/platform/hotel";
import { MAX_NOTE, PRIORITY_LABEL, readTicketDetail, STATUS_LABEL, TICKET_STATUSES } from "@/lib/platform/tickets";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Ticket({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ticketId } = await params;
  if (!z.guid().safeParse(ticketId).success) notFound();
  const search = await searchParams;
  const supabase = await createClient();
  const [{ data, error }, level] = await Promise.all([
    supabase.rpc("platform_ticket_detail", { p_ticket: ticketId }),
    supabase.rpc("platform_level"),
  ]);
  const k = readTicketDetail(data);
  if (error || !k) notFound();
  const admin = level.data === "admin";

  return (
    <main className="max-w-3xl space-y-8">
      <div>
        <p className="text-sm">
          <Link href="/platform/tickets" className={linkClass}>
            All tickets
          </Link>
        </p>
        <PageTitle className="mt-2">{k.title}</PageTitle>
        <p className="mt-2 text-muted">
          <span className="font-mono">{k.number}</span> ·{" "}
          <Link href={`/platform/${k.tenant_id}`} className={linkClass}>
            {k.tenant_name}
          </Link>{" "}
          · {STATUS_LABEL[k.status]} · {PRIORITY_LABEL[k.priority]} priority · opened {shortDate(k.created_at)}
          {k.resolved_at ? ` · ${STATUS_LABEL[k.status].toLowerCase()} ${shortDate(k.resolved_at)}` : ""}
        </p>
      </div>
      <PlatformNotice search={search} />

      {k.details && <p className="max-w-prose whitespace-pre-line">{k.details}</p>}

      {admin && (
        <form action={setTicketStatus} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="ticketId" value={k.id} />
          <span className="text-sm text-muted">Move to</span>
          {TICKET_STATUSES.filter((s) => s !== k.status).map((s) => (
            <button key={s} type="submit" name="status" value={s} className={buttonQuiet}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </form>
      )}

      <section aria-labelledby="notes">
        <SectionTitle id="notes">Notes</SectionTitle>
        {k.notes.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No notes yet.</p>
        ) : (
          <ol className="mt-2">
            {k.notes.map((n) => (
              <li key={n.id} className="border-b border-line py-3 text-sm">
                <p className="whitespace-pre-line">{n.note}</p>
                <p className="mt-1 text-xs text-muted">
                  {n.author ?? "Unknown"} · {shortDate(n.created_at)}
                </p>
              </li>
            ))}
          </ol>
        )}
        {admin && (
          <form action={addTicketNote} className="mt-4 grid max-w-xl gap-2">
            <input type="hidden" name="ticketId" value={k.id} />
            <label htmlFor="nn" className="block text-sm">
              Add a note
            </label>
            <textarea id="nn" name="note" rows={3} required maxLength={MAX_NOTE} className={inputClass} />
            <p className="text-xs text-muted">
              Notes are kept as written and cannot be edited or removed. No guest details, payment data or secrets.
            </p>
            <div>
              <button type="submit" className={buttonPrimary}>
                Add note
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
