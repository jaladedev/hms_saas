import Link from "next/link";
import { PriorityChip, ReportForm, StatusBadge } from "@/components/staff/maintenance-bits";
import { buttonPrimary, buttonQuiet, cardClass, inputClass, Notice, ErrorBanner, EmptyState, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import {
  actionsFor, countRequests, filterByPerson, formatDue, groupLive, placeOf, recentlyResolved, REQUEST_COLUMNS, sortRequests, type RequestRow,
} from "@/lib/staff/maintenance";
import { claimRequest, resolveRequest, startRequest } from "@/lib/staff/maintenance-actions";
import type { BoardRoom } from "@/lib/staff/room-board";
import { compareRoomNumbers } from "@/lib/staff/room-board";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Staff = { user_id: string; full_name: string };

/**
 * Maintenance: what is broken, who has it, what is overdue, what was fixed lately, and a form to report a fault.
 * It reads rooms and maintenance requests only (no guests, bookings or rates), so it works for every role that may
 * see maintenance. Buttons mirror the database rules; the database still decides. A request never changes a room's
 * status or availability; the room board shows which rooms have open repairs.
 */
export default async function MaintenancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const [userQ, roomQ, propQ, liveQ, doneQ] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("rooms").select("id, property_id, room_type_id, room_number, floor, operational_status, housekeeping_status").limit(1000),
    supabase.from("properties").select("id, name, timezone"),
    supabase.from("maintenance_requests").select(REQUEST_COLUMNS).in("status", ["open", "in_progress"]).limit(500),
    supabase.from("maintenance_requests").select(REQUEST_COLUMNS).eq("status", "resolved").gte("resolved_at", since).order("resolved_at", { ascending: false }).limit(100),
  ]);
  const userId = userQ.data.user?.id ?? "";
  const rooms = (roomQ.data ?? []) as BoardRoom[];
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const live = (liveQ.data ?? []) as RequestRow[];
  const resolved = recentlyResolved((doneQ.data ?? []) as RequestRow[], now);
  const loadError = Boolean(roomQ.error || propQ.error || liveQ.error || doneQ.error);

  // Permissions are per property; people who manage also need the names of the people they can hand work to.
  const canReport = new Map<string, boolean>();
  const canManage = new Map<string, boolean>();
  const staff = new Map<string, Staff[]>();
  await Promise.all(properties.map(async (p) => {
    const [view, manage] = await Promise.all([
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "maintenance.view" }),
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "maintenance.manage" }),
    ]);
    canManage.set(p.id, manage.data === true);
    canReport.set(p.id, view.data === true || manage.data === true);
    if (manage.data === true) {
      const { data } = await supabase.rpc("list_maintenance_staff", { p_property: p.id });
      staff.set(p.id, (data ?? []) as Staff[]);
    }
  }));

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const tz = new Map(properties.map((p) => [p.id, p.timezone]));
  const propName = new Map(properties.map((p) => [p.id, p.name]));
  const showProperty = properties.length > 1;
  const anyManager = [...canManage.values()].some(Boolean);
  const people = new Map<string, string>();
  for (const list of staff.values()) for (const s of list) people.set(s.user_id, s.full_name);
  const whoParam = search.who;
  const who = anyManager && typeof whoParam === "string" ? whoParam : "";

  const counts = countRequests(live, userId, now);
  const groups = groupLive(filterByPerson(sortRequests(live, roomById), who, userId), userId);
  const reportable = properties.filter((p) => canReport.get(p.id));
  const reportRooms = rooms
    .filter((r) => r.operational_status !== "retired" && canReport.get(r.property_id))
    .sort((a, b) => a.property_id.localeCompare(b.property_id) || compareRoomNumbers(a.room_number, b.room_number));
  const singleManager = reportable.length === 1 && canManage.get(reportable[0]?.id ?? "") === true;
  const reportKey = crypto.randomUUID();

  const whoHas = (r: RequestRow): string => {
    if (r.assigned_to === null) return "Nobody yet";
    if (r.assigned_to === userId) return "You";
    return people.get(r.assigned_to) ?? "Someone else";
  };

  function RequestCard({ r }: { r: RequestRow }) {
    const a = actionsFor(r, canManage.get(r.property_id) === true);
    const due = formatDue(r.due_at, tz.get(r.property_id) ?? "UTC", now);
    const place = placeOf(r, roomById);
    return (
      <li className={cardClass}>
        <div className="flex items-baseline justify-between gap-2">
          <Link href={`/app/maintenance/${r.id}`} className="font-semibold text-primary-strong underline underline-offset-2">{r.title}</Link>
          <span className="shrink-0 text-xs text-muted">{place}{showProperty ? `, ${propName.get(r.property_id) ?? ""}` : ""}</span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <PriorityChip priority={r.priority} />
          <StatusBadge status={r.status} />
        </p>
        {due && <p className={`mt-1 text-xs ${due.overdue ? "font-medium text-critical" : "text-muted"}`}>{due.text}</p>}
        {r.description && <p className="mt-1 line-clamp-2 text-sm">{r.description}</p>}
        <p className="mt-1 text-xs text-muted">With: {whoHas(r)}</p>

        {(a.claim || a.start || a.resolve) && (
          <div className="mt-3 flex flex-wrap items-start gap-2">
            {a.claim && (
              <form action={claimRequest}>
                <input type="hidden" name="requestId" value={r.id} />
                <button type="submit" className={buttonQuiet}>Take it</button>
              </form>
            )}
            {a.start && (
              <form action={startRequest}>
                <input type="hidden" name="requestId" value={r.id} />
                <button type="submit" className={buttonQuiet}>Start</button>
              </form>
            )}
            {a.resolve && (
              <form action={resolveRequest} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="requestId" value={r.id} />
                <input name="note" maxLength={1000} placeholder="What was done (optional)" aria-label={`What was done for ${r.title}`} className={`${inputClass} w-44`} />
                <button type="submit" className={buttonPrimary}>Fixed</button>
              </form>
            )}
          </div>
        )}
      </li>
    );
  }

  function Section({ title, hint, items }: { title: string; hint?: string; items: RequestRow[] }) {
    if (items.length === 0) return null;
    return (
      <section className="mt-8 first:mt-0" aria-label={title}>
        <SectionTitle>{title} <span className="text-base text-muted">({items.length})</span></SectionTitle>
        {hint && <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{items.map((r) => <RequestCard key={r.id} r={r} />)}</ul>
      </section>
    );
  }

  return (
    <main className="max-w-5xl">
      <PageTitle>Maintenance</PageTitle>
      <PageIntro>What is broken and who is fixing it, most urgent first. A repair never takes a room out of sale by itself; blocks are made on the room board.</PageIntro>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <ErrorBanner className="mb-6">The requests could not be loaded. Reload the page.</ErrorBanner>}

      {!loadError && (
        <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Request totals">
          <span><span className="font-semibold tabular-nums">{counts.open}</span> <span className="text-muted">open</span></span>
          <span><span className="font-semibold tabular-nums">{counts.highPriority}</span> <span className="text-muted">high priority</span></span>
          <span className={counts.overdue > 0 ? "text-critical" : undefined}><span className="font-semibold tabular-nums">{counts.overdue}</span> <span className={counts.overdue > 0 ? "" : "text-muted"}>overdue</span></span>
          <span><span className="font-semibold tabular-nums">{counts.mine}</span> <span className="text-muted">yours</span></span>
        </p>
      )}

      {anyManager && (
        <form method="get" className="mb-4 mt-4 flex flex-wrap items-center gap-2" aria-label="Filter requests">
          <label htmlFor="who" className="text-sm text-muted">Show</label>
          <select id="who" name="who" defaultValue={who} className={`${inputClass} w-auto`}>
            <option value="">Everyone's requests</option>
            <option value="me">Mine</option>
            <option value="unassigned">Nobody's</option>
            {[...people].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <button type="submit" className={buttonQuiet}>Show</button>
        </form>
      )}

      <div className="mt-6">
        {!loadError && counts.open === 0 && <EmptyState>No open requests right now.</EmptyState>}
        <Section title="My requests" items={groups.mine} />
        <Section title="Nobody has these yet" hint={anyManager ? "Take one, or start it and it becomes yours." : "Maintenance will pick these up."} items={groups.unassigned} />
        <Section title="With others" items={groups.others} />

        {resolved.length > 0 && (
          <section className="mt-8" aria-label="Resolved lately">
            <SectionTitle>Resolved in the last 7 days <span className="text-base text-muted">({resolved.length})</span></SectionTitle>
            <ul className="mt-3 divide-y divide-line rounded border border-line bg-white text-sm">
              {resolved.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                  <span>
                    <Link href={`/app/maintenance/${r.id}`} className="font-medium underline underline-offset-2">{r.title}</Link>{" "}
                    <span className="text-muted">{placeOf(r, roomById)}{r.resolution_note ? `: ${r.resolution_note}` : ""}</span>
                  </span>
                  <span className="text-xs text-muted">{new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: tz.get(r.property_id) ?? "UTC" }).format(new Date(r.resolved_at ?? now))}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {reportable.length > 0 && (
          <section className="mt-8" aria-label="Report a fault">
            <SectionTitle>Report a fault</SectionTitle>
            <div className="mt-3">
              <ReportForm
                properties={reportable.map((p) => ({ id: p.id, name: p.name }))}
                rooms={reportRooms}
                from="list"
                idempotencyKey={reportKey}
                canManage={singleManager}
                people={singleManager ? staff.get(reportable[0]?.id ?? "") : undefined}
              />
            </div>
            <p className="mt-2 max-w-prose text-xs text-muted">Reporting a fault tells maintenance. It does not block the room or change what can be booked.</p>
          </section>
        )}
      </div>
    </main>
  );
}
