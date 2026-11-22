import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { ReplyDraft } from "@/components/staff/reply-draft";
import { formatDate } from "@/lib/guest-site/format";
import { draftReply } from "@/lib/staff/ai-draft-actions";
import { setMessageStatus } from "@/lib/staff/contact-actions";
import { newCount, parseContactMessages, sortMessages } from "@/lib/staff/contact-messages";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props } = await supabase.from("properties").select("id, name").order("name");
  const properties = (props ?? []) as { id: string; name: string }[];
  const results = await Promise.all(properties.map((p) => supabase.rpc("contact_messages_list", { p_property: p.id })));
  const aiOn = await Promise.all(properties.map(async (p) => (await supabase.rpc("ai_helpers_on", { p_property: p.id })).data === true));
  const aiFor = new Set(properties.filter((_, i) => aiOn[i]).map((p) => p.id));
  // A hotel the person may not see messages for answers NOT_FOUND; that hotel is left out, any other failure is shown.
  const failed = results.some((r) => r.error && !/NOT_FOUND/.test(r.error.message));
  const many = properties.length > 1;
  const groups = properties
    .map((p, i) => ({ property: p, rows: sortMessages(parseContactMessages(results[i]?.data)) }))
    .filter((g) => g.rows.length > 0);
  const unread = groups.reduce((n, g) => n + newCount(g.rows), 0);

  return (
    <main className="max-w-4xl">
      <PageTitle>Guest messages</PageTitle>
      <PageIntro>
        Messages guests send from the contact page. Nothing is emailed to the hotel and no reply is sent from here: answer the guest by
        email or phone, then mark the message handled. Handled messages stay for a month; all messages are removed after three months.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
        {failed && <ErrorBanner className="mb-5">The messages could not be loaded. Reload the page to try again.</ErrorBanner>}
      </div>
      {unread > 0 && (
        <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
          {unread === 1 ? "1 message is waiting for an answer." : `${unread} messages are waiting for an answer.`}
        </p>
      )}
      {groups.length === 0 && !failed && <EmptyState className="mt-8">No messages yet.</EmptyState>}
      {groups.map((g) => (
        <section key={g.property.id} className="mt-6">
          {many && <h2 className="mb-2 font-display text-xl">{g.property.name}</h2>}
          <ul className="border-t border-line">
            {g.rows.map((r) => (
              <li key={r.id} className="border-b border-line py-5">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {r.guest_name}
                  {r.status === "new" ? (
                    <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-white">New</span>
                  ) : (
                    <span className="rounded-full bg-ink/5 px-2.5 py-0.5 text-xs text-muted">Handled</span>
                  )}
                  <span className="text-xs font-normal text-muted">{r.created_at ? formatDate(r.created_at.slice(0, 10)) : ""}</span>
                </p>
                <p className="mt-1 text-sm text-muted">
                  <a href={`mailto:${r.email}`} className="underline underline-offset-2">
                    {r.email}
                  </a>
                </p>
                <p className="mt-3 whitespace-pre-line break-words text-sm">{r.message}</p>
                {aiFor.has(g.property.id) && <ReplyDraft messageId={r.id} action={draftReply} />}
                <form action={setMessageStatus} className="mt-3 flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={r.id} />
                  {r.status === "new" ? (
                    <button type="submit" name="status" value="handled" className={buttonPrimary}>
                      Mark handled
                    </button>
                  ) : (
                    <button type="submit" name="status" value="new" className={buttonQuiet}>
                      Mark new again
                    </button>
                  )}
                </form>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
