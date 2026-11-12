import Link from "next/link";
import { notFound } from "next/navigation";
import { PriorityChip, StatusBadge } from "@/components/staff/maintenance-bits";
import { buttonDanger, buttonPrimary, buttonQuiet, inputClass, Notice, linkClass, PageTitle, SectionTitle } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import {
  actionsFor,
  blocksForRequest,
  formatDue,
  formatShort,
  PRIORITY_LABEL,
  REQUEST_COLUMNS,
  REQUEST_PRIORITIES,
  STATUS_LABEL,
  type RequestRow,
} from "@/lib/staff/maintenance";
import {
  assignRequest,
  cancelRequest,
  claimRequest,
  linkBlock,
  resolveRequest,
  setRequestPriority,
  startRequest,
} from "@/lib/staff/maintenance-actions";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type Staff = { user_id: string; full_name: string };
type Claim = {
  id: string;
  room_id: string;
  claim_type: string;
  start_date: string;
  end_date: string;
  block_reason: string | null;
  status: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One maintenance request: what was reported, where it stands, who has it, and the room block it is linked to.
 * Linking a block only records which block the room is out of sale for. Resolving the request does not remove the
 * block; this page says so whenever a linked block is still in force. Buttons mirror the database rules.
 */
export default async function MaintenanceRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const now = new Date();

  const [userQ, reqQ] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("maintenance_requests").select(REQUEST_COLUMNS).eq("id", id).maybeSingle(),
  ]);
  const r = reqQ.data as RequestRow | null;
  if (!r) notFound();
  const userId = userQ.data.user?.id ?? "";

  const [roomQ, propQ, manageQ] = await Promise.all([
    r.room_id ? supabase.from("rooms").select("id, room_number, floor").eq("id", r.room_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("properties").select("id, name, timezone").eq("id", r.property_id).maybeSingle(),
    supabase.rpc("has_permission", { p_property: r.property_id, p_permission: "maintenance.manage" }),
  ]);
  const room = roomQ.data as { id: string; room_number: string; floor: number | null } | null;
  const property = propQ.data as { id: string; name: string; timezone: string } | null;
  const tz = property?.timezone ?? "UTC";
  const canManage = manageQ.data === true;
  const today = todayIn(tz, now);

  const staffQ = canManage ? await supabase.rpc("list_maintenance_staff", { p_property: r.property_id }) : { data: [] };
  const staff = (staffQ.data ?? []) as Staff[];
  const nameOf = (uid: string | null): string => {
    if (!uid) return "Nobody yet";
    if (uid === userId) return "You";
    return staff.find((s) => s.user_id === uid)?.full_name ?? "A staff member";
  };

  // This room's blocks that have not ended, plus the one linked (even if released), to choose from and to show.
  const claimQ = r.room_id
    ? await supabase
        .from("room_inventory_claims")
        .select("id, room_id, claim_type, start_date, end_date, block_reason, status")
        .eq("room_id", r.room_id)
        .eq("claim_type", "block")
        .or(`end_date.gt.${today}${r.room_block_id ? `,id.eq.${r.room_block_id}` : ""}`)
        .limit(200)
    : { data: [] };
  const claims = (claimQ.data ?? []) as Claim[];
  const linked = r.room_block_id ? claims.find((c) => c.id === r.room_block_id) : undefined;
  const linkedActive = Boolean(linked && linked.status === "active" && linked.end_date > today);
  const describeBlock = (c: Claim) =>
    `${c.block_reason ?? "Blocked"}, ${formatDate(c.start_date)} to ${formatDate(c.end_date)}${c.status !== "active" ? " (removed)" : ""}`;
  const choices = blocksForRequest(
    r,
    claims.filter((c) => c.status === "active" || c.id === r.room_block_id),
    today,
    describeBlock,
  );

  const a = actionsFor(r, canManage);
  const due = formatDue(r.due_at, tz, now);
  const place = room
    ? `Room ${room.room_number}${room.floor !== null ? `, floor ${room.floor}` : ""}`
    : r.room_id
      ? "A room"
      : (r.location ?? "No place given");
  const hidden = (from = "detail") => (
    <>
      <input type="hidden" name="requestId" value={r.id} />
      <input type="hidden" name="from" value={from} />
    </>
  );
  const when = (iso: string | null) => formatShort(iso, tz);

  return (
    <main className="max-w-3xl">
      <p className="text-sm">
        <Link href="/app/maintenance" className={linkClass}>
          All maintenance
        </Link>
      </p>
      <PageTitle className="mt-2">{r.title}</PageTitle>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{place}</span>
        <PriorityChip priority={r.priority} />
        <StatusBadge status={r.status} />
      </p>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>

      {r.description && <p className="mt-2 max-w-prose whitespace-pre-line">{r.description}</p>}

      <dl className="mt-6 grid max-w-xl grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">Status</dt>
        <dd>{STATUS_LABEL[r.status] ?? r.status}</dd>
        <dt className="text-muted">With</dt>
        <dd>{nameOf(r.assigned_to)}</dd>
        {due && (
          <>
            <dt className="text-muted">Due</dt>
            <dd className={due.overdue && (r.status === "open" || r.status === "in_progress") ? "font-medium text-critical" : undefined}>
              {due.text.replace(/^Overdue, was due /, "").replace(/^Due /, "")}
              {due.overdue && (r.status === "open" || r.status === "in_progress") ? " (overdue)" : ""}
            </dd>
          </>
        )}
        <dt className="text-muted">Reported</dt>
        <dd>
          {when(r.created_at)}
          {r.reported_by ? `, by ${nameOf(r.reported_by)}` : ""}
        </dd>
        {r.started_at && (
          <>
            <dt className="text-muted">Started</dt>
            <dd>{when(r.started_at)}</dd>
          </>
        )}
        {r.resolved_at && (
          <>
            <dt className="text-muted">Resolved</dt>
            <dd>
              {when(r.resolved_at)}
              {r.resolution_note ? `: ${r.resolution_note}` : ""}
            </dd>
          </>
        )}
        {r.cancelled_at && (
          <>
            <dt className="text-muted">Cancelled</dt>
            <dd>
              {when(r.cancelled_at)}
              {r.cancel_reason ? `: ${r.cancel_reason}` : ""}
            </dd>
          </>
        )}
      </dl>

      {r.room_id && (
        <section className="mt-8" aria-label="Room block">
          <SectionTitle>Room block</SectionTitle>
          {linked ? (
            <p className="mt-2 max-w-prose text-sm">
              This room is out of sale for this: <span className="font-medium">{describeBlock(linked)}</span>.
              {linkedActive &&
                (r.status === "open" || r.status === "in_progress") &&
                " Fixing the fault will not put the room back on sale. Remove the block on the room board when it can be booked again."}
              {linkedActive &&
                r.status === "resolved" &&
                " The fault is fixed but the block is still in force, so the room cannot be booked. Remove it on the room board."}
            </p>
          ) : (
            <p className="mt-2 max-w-prose text-sm text-muted">
              No block is linked. A repair does not stop the room being booked; a block does, and blocks are made on the room board.
            </p>
          )}
          <p className="mt-2 text-sm">
            <Link href="/app/rooms" className={linkClass}>
              Open the room board
            </Link>
          </p>
          {a.linkBlock && (
            <form action={linkBlock} className="mt-3 flex flex-wrap items-center gap-2">
              {hidden()}
              <label htmlFor="blockId" className="text-sm text-muted">
                Linked block
              </label>
              <select id="blockId" name="blockId" defaultValue={r.room_block_id ?? ""} className={`${inputClass} w-auto max-w-full`}>
                <option value="">None</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <PendingButton className={buttonQuiet} pendingLabel="Saving…">
                Save link
              </PendingButton>
            </form>
          )}
        </section>
      )}

      {(a.claim || a.start || a.resolve) && (
        <section className="mt-8" aria-label="Work on this request">
          <SectionTitle>Work on it</SectionTitle>
          <div className="mt-3 flex flex-wrap items-start gap-2">
            {a.claim && (
              <form action={claimRequest}>
                {hidden()}
                <PendingButton className={buttonQuiet} pendingLabel="Saving…">
                  Take it
                </PendingButton>
              </form>
            )}
            {a.start && (
              <form action={startRequest}>
                {hidden()}
                <PendingButton className={buttonQuiet} pendingLabel="Starting…">
                  Start
                </PendingButton>
              </form>
            )}
          </div>
          {a.resolve && (
            <form action={resolveRequest} className="mt-3 grid max-w-xl gap-2">
              {hidden()}
              <label htmlFor="note" className="text-sm text-muted">
                What was done (optional)
              </label>
              <textarea id="note" name="note" maxLength={1000} rows={3} className={inputClass} />
              <div>
                <PendingButton className={buttonPrimary} pendingLabel="Saving…">
                  Mark as fixed
                </PendingButton>
              </div>
            </form>
          )}
        </section>
      )}

      {(a.assign || a.priority) && (
        <section className="mt-8" aria-label="Manage this request">
          <SectionTitle>Manage</SectionTitle>
          {a.assign && (
            <form action={assignRequest} className="mt-3 flex flex-wrap items-center gap-2">
              {hidden()}
              <label htmlFor="userId" className="text-sm text-muted">
                Give it to
              </label>
              <select id="userId" name="userId" defaultValue={r.assigned_to ?? ""} className={`${inputClass} w-auto`}>
                <option value="">Nobody</option>
                {staff.map((s) => (
                  <option key={s.user_id} value={s.user_id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
              <PendingButton className={buttonQuiet} pendingLabel="Assigning…">
                Assign
              </PendingButton>
            </form>
          )}
          {a.priority && (
            <form action={setRequestPriority} className="mt-3 flex flex-wrap items-center gap-2">
              {hidden()}
              <label htmlFor="priority" className="text-sm text-muted">
                Priority
              </label>
              <select id="priority" name="priority" defaultValue={r.priority} className={`${inputClass} w-auto`}>
                {REQUEST_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
              <PendingButton className={buttonQuiet} pendingLabel="Changing…">
                Change
              </PendingButton>
            </form>
          )}
          {a.cancel && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-muted underline underline-offset-2">Cancel this request</summary>
              <form action={cancelRequest} className="mt-2 flex flex-wrap items-center gap-2">
                {hidden()}
                <input
                  name="reason"
                  required
                  maxLength={200}
                  placeholder="Reason"
                  aria-label="Reason for cancelling"
                  className={`${inputClass} w-56`}
                />
                <PendingButton className={buttonDanger} pendingLabel="Cancelling…">
                  Cancel request
                </PendingButton>
              </form>
            </details>
          )}
        </section>
      )}
    </main>
  );
}
