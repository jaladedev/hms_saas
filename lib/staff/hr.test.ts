import { describe, expect, it } from "vitest";
import {
  classifyHrError,
  decimalHours,
  formatMinutes,
  hoursCsv,
  hoursFileName,
  parseAttendanceForm,
  parseDecideForm,
  parseHoursReport,
  parseLeaveForm,
  parseShiftForm,
  toLocalInput,
} from "./hr";

const P = "00000000-0000-0000-0000-0000000000a2";
const U = "11111111-1111-1111-1111-111111111111";

describe("error words", () => {
  it("maps database refusals to codes", () => {
    expect(classifyHrError("NOT_FOUND")).toBe("hr_forbidden");
    expect(classifyHrError("POLICY_VIOLATION: hr off")).toBe("hr_off");
    expect(classifyHrError("POLICY_VIOLATION: overlap")).toBe("hr_overlap");
    expect(classifyHrError("POLICY_VIOLATION: on leave")).toBe("hr_on_leave");
    expect(classifyHrError("POLICY_VIOLATION: has shifts")).toBe("hr_has_shifts");
    expect(classifyHrError("POLICY_VIOLATION: open row")).toBe("hr_open_row");
    expect(classifyHrError("INVALID_STATE: not clocked in")).toBe("hr_not_clocked_in");
    expect(classifyHrError("INVALID_STATE: past")).toBe("hr_past");
    expect(classifyHrError("INVALID_STATE: approved")).toBe("hr_state");
    expect(classifyHrError("POLICY_VIOLATION: dates")).toBe("hr_invalid");
    expect(classifyHrError("connection reset")).toBe("hr_failed");
  });
});

describe("forms", () => {
  it("reads a shift", () => {
    const v = parseShiftForm({
      propertyId: P,
      userId: U,
      startsAt: "2026-12-01T08:00",
      endsAt: "2026-12-01T16:00",
      label: " Desk ",
      note: "",
    });
    expect(v).toEqual({
      ok: true,
      value: {
        propertyId: P,
        shiftId: null,
        userId: U,
        startsAt: "2026-12-01T08:00:00",
        endsAt: "2026-12-01T16:00:00",
        label: "Desk",
        note: "",
      },
    });
  });
  it("refuses a shift that ends before it starts or has bad ids", () => {
    expect(parseShiftForm({ propertyId: P, userId: U, startsAt: "2026-12-01T16:00", endsAt: "2026-12-01T08:00" })).toEqual({
      ok: false,
      code: "hr_times",
    });
    expect(parseShiftForm({ propertyId: "x", userId: U, startsAt: "2026-12-01T08:00", endsAt: "2026-12-01T09:00" }).ok).toBe(false);
  });
  it("reads an attendance row, open or closed", () => {
    const open = parseAttendanceForm({ propertyId: P, userId: U, clockIn: "2026-12-01T08:00", clockOut: "", note: "x" });
    expect(open.ok && open.value.clockOut).toBeNull();
    expect(parseAttendanceForm({ propertyId: P, userId: U, clockIn: "2026-12-01T08:00", clockOut: "2026-12-01T07:00" })).toEqual({
      ok: false,
      code: "hr_times",
    });
    expect(parseAttendanceForm({ propertyId: P, userId: U, clockIn: "2026-12-01T08:00", clockOut: "nonsense" })).toEqual({
      ok: false,
      code: "hr_times",
    });
  });
  it("reads leave and defaults the end to the start", () => {
    const v = parseLeaveForm({ propertyId: P, start: "2026-12-01", end: "", kind: "sick", note: "" });
    expect(v.ok && v.value.end).toBe("2026-12-01");
    expect(parseLeaveForm({ propertyId: P, start: "2026-12-05", end: "2026-12-01", kind: "sick" })).toEqual({
      ok: false,
      code: "hr_times",
    });
    expect(parseLeaveForm({ propertyId: P, start: "2026-02-30", kind: "sick" })).toEqual({ ok: false, code: "hr_times" });
    expect(parseLeaveForm({ propertyId: P, start: "2026-12-01", kind: "holiday" }).ok).toBe(false);
  });
  it("reads a decision", () => {
    expect(parseDecideForm({ leaveId: U, decision: "approve" }).ok).toBe(true);
    expect(parseDecideForm({ leaveId: U, decision: "maybe" }).ok).toBe(false);
  });
});

describe("time words and local input", () => {
  it("formats minutes and hours", () => {
    expect(formatMinutes(485)).toBe("8h 05m");
    expect(decimalHours(90)).toBe("1.50");
    expect(decimalHours(-5)).toBe("0.00");
  });
  it("shows an instant in the hotel's own time", () => {
    expect(toLocalInput("2026-12-01T07:30:00Z", "Africa/Lagos")).toBe("2026-12-01T08:30");
    expect(toLocalInput("nonsense", "Africa/Lagos")).toBe("");
  });
});

describe("hours report and CSV", () => {
  const raw = {
    from: "2026-12-01",
    to: "2026-12-14",
    people: [
      {
        user_id: U,
        name: 'Ada "A" Obi',
        email: "ada@x.test",
        worked_minutes: 495,
        scheduled_minutes: 480,
        open_rows: 1,
        corrected_rows: 2,
        leave_days: { annual: 3 },
      },
    ],
  };
  it("reads the report", () => {
    const r = parseHoursReport(raw);
    expect(r?.people[0]?.leaveDays).toEqual({ annual: 3, sick: 0, unpaid: 0, other: 0 });
    expect(parseHoursReport(null)).toBeNull();
  });
  it("writes a CSV with hours, leave and no pay", () => {
    const csv = hoursCsv(parseHoursReport(raw)!);
    const lines = csv.trimEnd().split("\r\n") as [string, string];
    expect(lines[0]).toBe(
      "Name,Email,Worked hours,Scheduled hours,Annual leave days,Sick leave days,Unpaid leave days,Other leave days,Open clock-ins,Corrected rows",
    );
    expect(lines[1]).toBe('"Ada ""A"" Obi",ada@x.test,8.25,8.00,3,0,0,0,1,2');
    expect(/pay|salary/i.test(lines[0])).toBe(false);
  });
  it("names the file safely", () => {
    expect(hoursFileName("Hotel Ade's / Lagos!", "2026-12-01", "2026-12-14")).toBe("hours-hotel-ade-s-lagos-2026-12-01-to-2026-12-14.csv");
  });
});
