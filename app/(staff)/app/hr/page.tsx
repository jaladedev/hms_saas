import Link from "next/link";
import { HrNotice } from "@/components/staff/hr-notice";
import {
  buttonPrimary,
  buttonQuiet,
  cardClass,
  EmptyState,
  ErrorBanner,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDateTime } from "@/lib/staff/format";
import {
  formatMinutes,
  LEAVE_KIND_LABEL,
  LEAVE_KINDS,
  LEAVE_STATUS_LABEL,
  parseAttendance,
  parseLeave,
  parsePeople,
  parseShifts,
  toLocalInput,
} from "@/lib/staff/hr";
import { loadHrContext } from "@/lib/staff/hr-access";
import { cancelLeave, clockIn, clockOut, decideLeave, removeShift, requestLeave, saveAttendance, saveShift } from "@/lib/staff/hr-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Shifts, clocking and leave (migration 162). Everyone who works at the hotel sees the rota, clocks in and out and asks for leave. The owner
 * or general manager makes the rota, decides leave, corrects attendance and takes the hours report. There is no pay calculation.
 */
export default async function HrPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, userId, loadFailed, property, can } = await loadHrContext(first(search.property));
  const heading = <PageTitle>Shifts and leave</PageTitle>;
  if (loadFailed || !property)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">Shifts and leave are for people who work at a hotel in your group.</p>
        )}
      </main>
    );
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const [peopleQ, shiftsQ, attQ, leaveQ] = await Promise.all([
    supabase.rpc("hr_people", { p_property: property.id }),
    supabase
      .from("staff_shifts")
      .select("id, user_id, starts_at, ends_at, label, note")
      .eq("property_id", property.id)
      .gte("ends_at", since)
      .order("starts_at")
      .limit(200),
    supabase
      .from("staff_attendance")
      .select("id, user_id, clock_in_at, clock_out_at, corrected, note")
      .eq("property_id", property.id)
      .order("clock_in_at", { ascending: false })
      .limit(40),
    supabase
      .from("staff_leave")
      .select("id, user_id, start_date, end_date, kind, status, note")
      .eq("property_id", property.id)
      .order("start_date", { ascending: false })
      .limit(60),
  ]);
  const people = parsePeople(peopleQ.data);
  const nameOf = (id: string) => people.find((p) => p.userId === id)?.name ?? "Former staff";
  const shifts = parseShifts(shiftsQ.data);
  const attendance = parseAttendance(attQ.data);
  const leave = parseLeave(leaveQ.data);
  const open = attendance.find((a) => a.userId === userId && a.clockOutAt === null);
  const mine = (id: string) => id === userId;
  const when = (iso: string) => formatDateTime(iso, property.timezone);
  const pending = leave.filter((l) => l.status === "requested");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        The rota for the next days, clock in and out, and leave. Times are hotel time ({property.timezone}). A manager can correct a missed
        clock-in; corrected rows are marked. Hours are recorded here; pay is worked out elsewhere.
      </PageIntro>
      {can.manage && (
        <p className="mt-2 text-sm">
          <Link href={`/app/hr/report?property=${property.id}`} className={linkClass}>
            Hours report and CSV
          </Link>
        </p>
      )}
      <div className="mt-5">
        <HrNotice search={search} />
      </div>
      {(peopleQ.error || shiftsQ.error || attQ.error || leaveQ.error) && (
        <ErrorBanner className="mb-5">Some of this could not be loaded. Reload the page.</ErrorBanner>
      )}

      <section className={cardClass} aria-label="Clock">
        <SectionTitle>My clock</SectionTitle>
        {open ? (
          <form action={clockOut} className="mt-2 flex flex-wrap items-center gap-3">
            <input type="hidden" name="propertyId" value={property.id} />
            <p className="text-sm">Clocked in since {when(open.clockInAt)}.</p>
            <PendingButton className={buttonPrimary}>Clock out</PendingButton>
          </form>
        ) : (
          <form action={clockIn} className="mt-2 flex flex-wrap items-center gap-3">
            <input type="hidden" name="propertyId" value={property.id} />
            <p className="text-sm text-muted">You are not clocked in.</p>
            <PendingButton className={buttonPrimary}>Clock in</PendingButton>
          </form>
        )}
      </section>

      <section className="mt-8" aria-label="Rota">
        <SectionTitle>Rota</SectionTitle>
        {shifts.length === 0 ? (
          <EmptyState className="mt-3">No shifts yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {shifts.map((s) => (
              <li key={s.id} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {nameOf(s.userId)}
                    {mine(s.userId) ? " (you)" : ""} {s.label && <span className="text-xs font-normal text-muted">{s.label}</span>}
                  </p>
                  <p className="text-sm">
                    {when(s.startsAt)} to {when(s.endsAt)}
                  </p>
                </div>
                {s.note && <p className="text-sm text-muted">{s.note}</p>}
                {can.manage && (
                  <form action={removeShift} className="mt-2">
                    <input type="hidden" name="shiftId" value={s.id} />
                    <PendingButton className={buttonQuiet}>Remove</PendingButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {can.manage && (
          <form action={saveShift} className={`${cardClass} mt-3`}>
            <input type="hidden" name="propertyId" value={property.id} />
            <div className="flex flex-wrap items-end gap-3">
              <label className="block text-xs" htmlFor="shiftUser">
                Person
                <select id="shiftUser" name="userId" required className={`${inputClass} mt-1`}>
                  {people.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs" htmlFor="shiftStart">
                Starts
                <input id="shiftStart" name="startsAt" type="datetime-local" required className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-xs" htmlFor="shiftEnd">
                Ends
                <input id="shiftEnd" name="endsAt" type="datetime-local" required className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-xs" htmlFor="shiftLabel">
                Label
                <input id="shiftLabel" name="label" maxLength={40} className={`${inputClass} mt-1 w-32`} />
              </label>
              <label className="block text-xs" htmlFor="shiftNote">
                Note
                <input id="shiftNote" name="note" maxLength={200} className={`${inputClass} mt-1 w-40`} />
              </label>
              <PendingButton className={buttonPrimary}>Add shift</PendingButton>
            </div>
          </form>
        )}
      </section>

      <section className="mt-8" aria-label="Leave">
        <SectionTitle>Leave</SectionTitle>
        {can.manage && pending.length > 0 && <p className="mt-2 text-sm font-medium">{pending.length} waiting for a decision</p>}
        {leave.length === 0 ? (
          <EmptyState className="mt-3">No leave requests.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {leave.map((l) => (
              <li key={l.id} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {nameOf(l.userId)}
                    {mine(l.userId) ? " (you)" : ""} <span className="text-xs font-normal text-muted">{LEAVE_KIND_LABEL[l.kind]}</span>
                  </p>
                  <p className="text-sm">
                    {l.startDate}
                    {l.endDate !== l.startDate ? ` to ${l.endDate}` : ""} · <strong>{LEAVE_STATUS_LABEL[l.status]}</strong>
                  </p>
                </div>
                {l.note && <p className="text-sm text-muted">{l.note}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {can.manage && l.status === "requested" && (
                    <>
                      <form action={decideLeave}>
                        <input type="hidden" name="leaveId" value={l.id} />
                        <input type="hidden" name="decision" value="approve" />
                        <PendingButton className={buttonPrimary}>Approve</PendingButton>
                      </form>
                      <form action={decideLeave}>
                        <input type="hidden" name="leaveId" value={l.id} />
                        <input type="hidden" name="decision" value="reject" />
                        <PendingButton className={buttonQuiet}>Do not approve</PendingButton>
                      </form>
                    </>
                  )}
                  {(l.status === "requested" || l.status === "approved") && l.endDate >= today && (mine(l.userId) || can.manage) && (
                    <form action={cancelLeave}>
                      <input type="hidden" name="leaveId" value={l.id} />
                      <PendingButton className={buttonQuiet}>Cancel</PendingButton>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <form action={requestLeave} className={`${cardClass} mt-3`}>
          <input type="hidden" name="propertyId" value={property.id} />
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-xs" htmlFor="leaveKind">
              Kind
              <select id="leaveKind" name="kind" className={`${inputClass} mt-1`}>
                {LEAVE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {LEAVE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs" htmlFor="leaveStart">
              From
              <input id="leaveStart" name="start" type="date" required className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs" htmlFor="leaveEnd">
              To (blank for one day)
              <input id="leaveEnd" name="end" type="date" className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs" htmlFor="leaveNote">
              Note
              <input id="leaveNote" name="note" maxLength={200} className={`${inputClass} mt-1 w-40`} />
            </label>
            <PendingButton className={buttonPrimary}>Request leave</PendingButton>
          </div>
        </form>
      </section>

      <section className="mt-8" aria-label="Attendance">
        <SectionTitle>{can.manage ? "Attendance" : "My attendance"}</SectionTitle>
        {attendance.length === 0 ? (
          <EmptyState className="mt-3">No attendance yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {attendance.map((a) => (
              <li key={a.id} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {nameOf(a.userId)}
                    {mine(a.userId) ? " (you)" : ""} {a.corrected && <span className="text-xs font-normal text-muted">corrected</span>}
                  </p>
                  <p className="text-sm">
                    {when(a.clockInAt)} to {a.clockOutAt ? when(a.clockOutAt) : "still clocked in"}
                    {a.clockOutAt
                      ? ` · ${formatMinutes((new Date(a.clockOutAt).getTime() - new Date(a.clockInAt).getTime()) / 60000)}`
                      : ""}
                  </p>
                </div>
                {a.note && <p className="text-sm text-muted">{a.note}</p>}
                {can.manage && (
                  <form action={saveAttendance} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="propertyId" value={property.id} />
                    <input type="hidden" name="attendanceId" value={a.id} />
                    <input type="hidden" name="userId" value={a.userId} />
                    <input
                      name="clockIn"
                      type="datetime-local"
                      required
                      defaultValue={toLocalInput(a.clockInAt, property.timezone)}
                      className={inputClass}
                      aria-label="Clock in"
                    />
                    <input
                      name="clockOut"
                      type="datetime-local"
                      defaultValue={a.clockOutAt ? toLocalInput(a.clockOutAt, property.timezone) : ""}
                      className={inputClass}
                      aria-label="Clock out"
                    />
                    <input
                      name="note"
                      maxLength={200}
                      placeholder="Reason"
                      defaultValue={a.note ?? ""}
                      className={`${inputClass} w-40`}
                      aria-label="Reason"
                    />
                    <PendingButton className={buttonQuiet}>Correct</PendingButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {can.manage && (
          <form action={saveAttendance} className={`${cardClass} mt-3`}>
            <input type="hidden" name="propertyId" value={property.id} />
            <p className="text-xs text-muted">Add a missed clock-in and clock-out.</p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <label className="block text-xs" htmlFor="attUser">
                Person
                <select id="attUser" name="userId" required className={`${inputClass} mt-1`}>
                  {people.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs" htmlFor="attIn">
                In
                <input id="attIn" name="clockIn" type="datetime-local" required className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-xs" htmlFor="attOut">
                Out
                <input id="attOut" name="clockOut" type="datetime-local" className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-xs" htmlFor="attNote">
                Reason
                <input id="attNote" name="note" maxLength={200} className={`${inputClass} mt-1 w-40`} />
              </label>
              <PendingButton className={buttonPrimary}>Add</PendingButton>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
