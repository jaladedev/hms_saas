import { csvField } from "./reports-csv";
import { parseLocalDateTime } from "./events";

/**
 * Staff shifts, attendance and leave (migration 162): reading what the database returns, checking what a form sends, the words the screens use
 * and the hours CSV. Pure, so it is tested without a server. The database checks everything again on every call. There is no pay calculation:
 * the CSV is hours and leave days only.
 */

export const LEAVE_KINDS = ["annual", "sick", "unpaid", "other"] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];
export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  unpaid: "Unpaid leave",
  other: "Other",
};
export const LEAVE_STATUS_LABEL = {
  requested: "Waiting for a decision",
  approved: "Approved",
  rejected: "Not approved",
  cancelled: "Cancelled",
} as const;
export type LeaveStatus = keyof typeof LEAVE_STATUS_LABEL;

// ---- wording ---------------------------------------------------------------------------------

export type HrErrorCode =
  | "hr_forbidden"
  | "hr_off"
  | "hr_invalid"
  | "hr_person"
  | "hr_times"
  | "hr_overlap"
  | "hr_on_leave"
  | "hr_has_shifts"
  | "hr_open_row"
  | "hr_not_clocked_in"
  | "hr_state"
  | "hr_past"
  | "hr_failed";

export const HR_ERROR_MESSAGES: Record<HrErrorCode, string> = {
  hr_forbidden:
    "You do not have permission to do that here. The rota, corrections and leave decisions are for the owner or general manager.",
  hr_off: "Shifts and leave are switched off for your hotel group. Everything already saved is kept. Contact the platform.",
  hr_invalid: "Check the details and try again.",
  hr_person: "Choose someone who works at this hotel.",
  hr_times:
    "Check the times. The end must be after the start, a shift is at most 16 hours, a worked period at most 20 hours, and nothing worked can be in the future.",
  hr_overlap: "That overlaps another shift or leave request for the same person.",
  hr_on_leave: "That person is on approved leave on one of those days.",
  hr_has_shifts: "That person has shifts on those days. Move or remove them first, then approve the leave.",
  hr_open_row: "That person is already clocked in. Close the open row first.",
  hr_not_clocked_in: "You are not clocked in.",
  hr_state: "That has already moved on, so that step is not possible.",
  hr_past: "A shift that ended more than 7 days ago cannot be removed.",
  hr_failed: "That did not work. Reload the page and try again.",
};

export const HR_OK_MESSAGES = {
  hr_shift: "Shift saved.",
  hr_shift_removed: "Shift removed.",
  hr_in: "Clocked in.",
  hr_out: "Clocked out.",
  hr_attendance: "Attendance saved.",
  hr_requested: "Leave requested. A manager will decide.",
  hr_approved: "Leave approved.",
  hr_rejected: "Leave not approved.",
  hr_cancelled: "Leave cancelled.",
} as const;
export type HrOkCode = keyof typeof HR_OK_MESSAGES;

/** Turns a database refusal into a code; raw database text never reaches the browser. */
export function classifyHrError(message: string): HrErrorCode {
  if (/NOT_FOUND/.test(message)) return "hr_forbidden";
  if (/hr off/.test(message)) return "hr_off";
  if (/POLICY_VIOLATION: person/.test(message)) return "hr_person";
  if (/POLICY_VIOLATION: times/.test(message)) return "hr_times";
  if (/POLICY_VIOLATION: overlap/.test(message)) return "hr_overlap";
  if (/POLICY_VIOLATION: on leave/.test(message)) return "hr_on_leave";
  if (/POLICY_VIOLATION: has shifts/.test(message)) return "hr_has_shifts";
  if (/POLICY_VIOLATION: open row/.test(message)) return "hr_open_row";
  if (/INVALID_STATE: not clocked in/.test(message)) return "hr_not_clocked_in";
  if (/INVALID_STATE: past/.test(message)) return "hr_past";
  if (/INVALID_STATE/.test(message)) return "hr_state";
  if (/POLICY_VIOLATION/.test(message)) return "hr_invalid";
  return "hr_failed";
}

// ---- time words ----------------------------------------------------------------------------------

/** 485 as "8h 05m". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
/** 485 as "8.08", hours with two decimals for a spreadsheet. */
export const decimalHours = (minutes: number): string => (Math.max(0, minutes) / 60).toFixed(2);

// ---- reading what the database returns ------------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : []);

export type Person = { userId: string; name: string; email: string | null };
export function parsePeople(raw: unknown): Person[] {
  return arr(raw).map((r) => ({ userId: str(r.user_id), name: str(r.name) || "Unnamed", email: strOrNull(r.email) }));
}

export type Shift = { id: string; userId: string; startsAt: string; endsAt: string; label: string | null; note: string | null };
export function parseShifts(raw: unknown): Shift[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    userId: str(r.user_id),
    startsAt: str(r.starts_at),
    endsAt: str(r.ends_at),
    label: strOrNull(r.label),
    note: strOrNull(r.note),
  }));
}

export type Attendance = {
  id: string;
  userId: string;
  clockInAt: string;
  clockOutAt: string | null;
  corrected: boolean;
  note: string | null;
};
export function parseAttendance(raw: unknown): Attendance[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    userId: str(r.user_id),
    clockInAt: str(r.clock_in_at),
    clockOutAt: strOrNull(r.clock_out_at),
    corrected: r.corrected === true,
    note: strOrNull(r.note),
  }));
}

export type Leave = {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  kind: LeaveKind;
  status: LeaveStatus;
  note: string | null;
};
export function parseLeave(raw: unknown): Leave[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    userId: str(r.user_id),
    startDate: str(r.start_date),
    endDate: str(r.end_date),
    kind: (LEAVE_KINDS as readonly string[]).includes(str(r.kind)) ? (str(r.kind) as LeaveKind) : "other",
    status: str(r.status) in LEAVE_STATUS_LABEL ? (str(r.status) as LeaveStatus) : "requested",
    note: strOrNull(r.note),
  }));
}

export type HoursRow = {
  userId: string;
  name: string;
  email: string;
  workedMinutes: number;
  scheduledMinutes: number;
  openRows: number;
  correctedRows: number;
  leaveDays: Record<LeaveKind, number>;
};
export type HoursReport = { from: string; to: string; people: HoursRow[] };
export function parseHoursReport(raw: unknown): HoursReport | null {
  const r = rec(raw);
  if (!r) return null;
  return {
    from: str(r.from),
    to: str(r.to),
    people: arr(r.people).map((p) => {
      const l = rec(p.leave_days) ?? {};
      return {
        userId: str(p.user_id),
        name: str(p.name),
        email: str(p.email),
        workedMinutes: num(p.worked_minutes),
        scheduledMinutes: num(p.scheduled_minutes),
        openRows: num(p.open_rows),
        correctedRows: num(p.corrected_rows),
        leaveDays: { annual: num(l.annual), sick: num(l.sick), unpaid: num(l.unpaid), other: num(l.other) },
      };
    }),
  };
}

// ---- the hours CSV --------------------------------------------------------------------------------------

/** Hours worked and leave days per person, nothing about pay. Worked hours are as clocked and corrected; open rows are counted so they are not missed. */
export function hoursCsv(report: HoursReport): string {
  const head = [
    "Name",
    "Email",
    "Worked hours",
    "Scheduled hours",
    "Annual leave days",
    "Sick leave days",
    "Unpaid leave days",
    "Other leave days",
    "Open clock-ins",
    "Corrected rows",
  ];
  const lines = [head.map(csvField).join(",")];
  for (const p of report.people) {
    lines.push(
      [
        p.name,
        p.email,
        decimalHours(p.workedMinutes),
        decimalHours(p.scheduledMinutes),
        p.leaveDays.annual,
        p.leaveDays.sick,
        p.leaveDays.unpaid,
        p.leaveDays.other,
        p.openRows,
        p.correctedRows,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
export const hoursFileName = (propertyName: string, from: string, to: string) =>
  `hours-${
    propertyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "hotel"
  }-${from}-to-${to}.csv`;

// ---- forms ------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string) => UUID.test(v);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isDate = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};
type Parsed<T> = { ok: true; value: T } | { ok: false; code: HrErrorCode };
const bad = { ok: false, code: "hr_invalid" } as const;

export function parseShiftForm(raw: Record<string, unknown>): Parsed<{
  propertyId: string;
  shiftId: string | null;
  userId: string;
  startsAt: string;
  endsAt: string;
  label: string;
  note: string;
}> {
  const propertyId = text(raw.propertyId);
  const userId = text(raw.userId);
  const shiftId = text(raw.shiftId);
  const startsAt = parseLocalDateTime(raw.startsAt);
  const endsAt = parseLocalDateTime(raw.endsAt);
  const label = text(raw.label);
  const note = text(raw.note);
  if (!isUuid(propertyId) || !isUuid(userId) || (shiftId !== "" && !isUuid(shiftId))) return bad;
  if (!startsAt || !endsAt || startsAt >= endsAt) return { ok: false, code: "hr_times" };
  if (label.length > 40 || note.length > 200) return bad;
  return { ok: true, value: { propertyId, shiftId: shiftId || null, userId, startsAt, endsAt, label, note } };
}

export function parseAttendanceForm(raw: Record<string, unknown>): Parsed<{
  propertyId: string;
  attendanceId: string | null;
  userId: string;
  clockIn: string;
  clockOut: string | null;
  note: string;
}> {
  const propertyId = text(raw.propertyId);
  const userId = text(raw.userId);
  const attendanceId = text(raw.attendanceId);
  const clockIn = parseLocalDateTime(raw.clockIn);
  const outRaw = text(raw.clockOut);
  const clockOut = outRaw === "" ? null : parseLocalDateTime(outRaw);
  const note = text(raw.note);
  if (!isUuid(propertyId) || !isUuid(userId) || (attendanceId !== "" && !isUuid(attendanceId))) return bad;
  if (!clockIn || (outRaw !== "" && !clockOut) || (clockOut && clockIn >= clockOut)) return { ok: false, code: "hr_times" };
  if (note.length > 200) return bad;
  return { ok: true, value: { propertyId, attendanceId: attendanceId || null, userId, clockIn, clockOut, note } };
}

export function parseLeaveForm(
  raw: Record<string, unknown>,
): Parsed<{ propertyId: string; start: string; end: string; kind: LeaveKind; note: string }> {
  const propertyId = text(raw.propertyId);
  const start = text(raw.start);
  const end = text(raw.end) || start;
  const kind = text(raw.kind);
  const note = text(raw.note);
  if (!isUuid(propertyId) || !(LEAVE_KINDS as readonly string[]).includes(kind) || note.length > 200) return bad;
  if (!isDate(start) || !isDate(end) || end < start) return { ok: false, code: "hr_times" };
  return { ok: true, value: { propertyId, start, end, kind: kind as LeaveKind, note } };
}

export function parseDecideForm(raw: Record<string, unknown>): Parsed<{ leaveId: string; decision: "approve" | "reject" }> {
  const leaveId = text(raw.leaveId);
  const decision = text(raw.decision);
  if (!isUuid(leaveId) || (decision !== "approve" && decision !== "reject")) return bad;
  return { ok: true, value: { leaveId, decision } };
}

export function parseIdForm(raw: Record<string, unknown>, field: string): Parsed<string> {
  const id = text(raw[field]);
  return isUuid(id) ? { ok: true, value: id } : bad;
}

export function parsePropertyForm(raw: Record<string, unknown>): Parsed<string> {
  return parseIdForm(raw, "propertyId");
}

/** Hotel-local "2026-12-01T09:00" for a datetime-local field from a UTC instant. */
export function toLocalInput(iso: string, timeZone: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(t);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}
