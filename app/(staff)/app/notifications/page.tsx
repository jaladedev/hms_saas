import Link from "next/link";
import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, linkClass, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatDateTime } from "@/lib/staff/format";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/staff/notification-actions";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  groupByDay,
  parseCategory,
  parseInbox,
  safeLink,
  SEVERITY_LABEL,
  type NotificationItem,
  type NotificationSeverity,
} from "@/lib/staff/notifications";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SEV_CHIP: Record<NotificationSeverity, string> = {
  urgent: "bg-critical/10 text-critical",
  attention: "bg-pending/10 text-pending",
  info: "bg-ink/10 text-muted",
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const category = parseCategory(search.category);
  const onlyUnread = search.unread === "1";
  const supabase = await createClient();

  const [inboxQ, propQ] = await Promise.all([
    supabase.rpc("notification_inbox", { p_limit: 100, p_only_unread: onlyUnread, p_category: category }),
    supabase.from("properties").select("id, timezone"),
  ]);
  const inbox = parseInbox(inboxQ.data);
  const zones = new Map(((propQ.data ?? []) as { id: string; timezone: string }[]).map((p) => [p.id, p.timezone]));
  const showProperty = new Set(inbox.items.map((i) => i.property_id)).size > 1;
  const tzOf = (i: NotificationItem) => zones.get(i.property_id) ?? "UTC";
  // Days are shown in the zone of the first hotel; a mixed list is rare and the time on each row is always its own hotel's.
  const groups = groupByDay(inbox.items, inbox.items[0] ? tzOf(inbox.items[0]) : "UTC");

  const href = (cat: string | null, unread: boolean) => {
    const qs = new URLSearchParams();
    if (cat) qs.set("category", cat);
    if (unread) qs.set("unread", "1");
    const s = qs.toString();
    return s ? `/app/notifications?${s}` : "/app/notifications";
  };
  const tab = (active: boolean) =>
    `rounded px-3 py-1.5 text-sm ${active ? "bg-navy-900 text-white" : "bg-ink/5 text-ink hover:bg-ink/10"} focus-visible:outline-2 focus-visible:outline-primary`;

  return (
    <main className="max-w-4xl">
      <PageTitle>Notifications</PageTitle>
      <PageIntro>
        Things that need a person: money problems, urgent repairs, booking changes and rooms housekeeping must hurry. You only see what your
        role allows, and reading a notice here does not mark it read for anyone else.
      </PageIntro>

      {inboxQ.error && <ErrorBanner className="mt-5">Notifications could not be loaded. Reload the page.</ErrorBanner>}

      <div className="mt-6 flex flex-wrap items-center gap-2" role="navigation" aria-label="Filter notifications">
        <Link href={href(null, onlyUnread)} className={tab(!category)} aria-current={!category ? "page" : undefined}>
          All{inbox.unread.total > 0 && <span className="ml-1 tabular-nums">({inbox.unread.total})</span>}
        </Link>
        {CATEGORIES.map((c) => (
          <Link key={c} href={href(c, onlyUnread)} className={tab(category === c)} aria-current={category === c ? "page" : undefined}>
            {CATEGORY_LABEL[c]}
            {inbox.unread[c] > 0 && <span className="ml-1 tabular-nums">({inbox.unread[c]})</span>}
          </Link>
        ))}
        <span className="mx-1 text-muted" aria-hidden="true">
          |
        </span>
        <Link href={href(category, !onlyUnread)} className={linkClass}>
          {onlyUnread ? "Show read ones too" : "Unread only"}
        </Link>
        {inbox.unread.total > 0 && (
          <form action={markAllNotificationsRead} className="ml-auto">
            <input type="hidden" name="category" value={category ?? ""} />
            <button type="submit" className={buttonQuiet}>
              Mark {category ? CATEGORY_LABEL[category].toLowerCase() : "all"} read
            </button>
          </form>
        )}
      </div>

      {groups.length === 0 && !inboxQ.error && (
        <EmptyState className="mt-8">{onlyUnread ? "Nothing unread. You are up to date." : "No notifications yet."}</EmptyState>
      )}

      {groups.map((g) => (
        <section key={g.day} className="mt-8">
          <h2 className="text-sm font-medium text-muted">{g.day}</h2>
          <ul className="mt-2 border-t border-line">
            {g.items.map((i) => {
              const link = safeLink(i.link);
              return (
                <li
                  key={i.id}
                  className={`grid gap-x-6 gap-y-2 border-b border-line py-4 md:grid-cols-[minmax(0,1fr)_auto] ${i.read ? "text-muted" : ""}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {!i.read && <span className="size-2 rounded-full bg-primary" aria-hidden="true" />}
                      <span className={i.read ? "" : "font-medium text-ink"}>{i.title}</span>
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${SEV_CHIP[i.severity]}`}>
                        {SEVERITY_LABEL[i.severity]}
                      </span>
                      <span className="text-xs">{CATEGORY_LABEL[i.category]}</span>
                      {!i.read && <span className="sr-only">Unread</span>}
                    </div>
                    {i.body && <p className="mt-1 max-w-prose break-words text-sm">{i.body}</p>}
                    <p className="mt-1 text-xs">
                      {formatDateTime(i.created_at, tzOf(i))}
                      {showProperty ? `, ${i.property_name}` : ""}
                    </p>
                  </div>
                  <div className="flex items-start gap-3 md:justify-self-end">
                    {link && (
                      <form action={markNotificationRead}>
                        <input type="hidden" name="id" value={i.id} />
                        <input type="hidden" name="next" value={link} />
                        <button type="submit" className={buttonPrimary}>
                          Open
                        </button>
                      </form>
                    )}
                    {!i.read && (
                      <form action={markNotificationRead}>
                        <input type="hidden" name="id" value={i.id} />
                        <button type="submit" className={buttonQuiet}>
                          Mark read
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}
