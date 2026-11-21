"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import {
  classifyHrError,
  parseAttendanceForm,
  parseDecideForm,
  parseIdForm,
  parseLeaveForm,
  parsePropertyForm,
  parseShiftForm,
  type HrErrorCode,
  type HrOkCode,
} from "./hr";

/**
 * Shift, clocking and leave actions (migration 162). Each runs as the signed-in person; the database checks who works here or holds hr.manage,
 * the staff_hr flag and every rule, and answers with a refusal that is shown as a short code, never as database text.
 */
const PAGE = "/app/hr";
const fail = (code: HrErrorCode): never => back(PAGE, { hrerr: code });
const done = (code: HrOkCode): never => {
  revalidatePath(PAGE);
  return back(PAGE, { hr: code });
};

export async function saveShift(formData: FormData) {
  const v = parseShiftForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_shift_save", {
    p_property: v.value.propertyId,
    p_shift: v.value.shiftId as string,
    p_user: v.value.userId,
    p_starts: v.value.startsAt,
    p_ends: v.value.endsAt,
    p_label: v.value.label,
    p_note: v.value.note,
  });
  if (error) return fail(classifyHrError(error.message));
  return done("hr_shift");
}

export async function removeShift(formData: FormData) {
  const v = parseIdForm(Object.fromEntries(formData), "shiftId");
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_shift_remove", { p_shift: v.value });
  if (error) return fail(classifyHrError(error.message));
  return done("hr_shift_removed");
}

export async function clockIn(formData: FormData) {
  const v = parsePropertyForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_clock_in", { p_property: v.value });
  if (error) return fail(classifyHrError(error.message));
  return done("hr_in");
}

export async function clockOut(formData: FormData) {
  const v = parsePropertyForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_clock_out", { p_property: v.value });
  if (error) return fail(classifyHrError(error.message));
  return done("hr_out");
}

export async function saveAttendance(formData: FormData) {
  const v = parseAttendanceForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_attendance_save", {
    p_property: v.value.propertyId,
    p_attendance: v.value.attendanceId as string,
    p_user: v.value.userId,
    p_in: v.value.clockIn,
    p_out: v.value.clockOut as string,
    p_note: v.value.note,
  });
  if (error) return fail(classifyHrError(error.message));
  return done("hr_attendance");
}

export async function requestLeave(formData: FormData) {
  const v = parseLeaveForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_leave_request", {
    p_property: v.value.propertyId,
    p_start: v.value.start,
    p_end: v.value.end,
    p_kind: v.value.kind,
    p_note: v.value.note,
  });
  if (error) return fail(classifyHrError(error.message));
  return done("hr_requested");
}

export async function decideLeave(formData: FormData) {
  const v = parseDecideForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_leave_decide", { p_leave: v.value.leaveId, p_decision: v.value.decision });
  if (error) return fail(classifyHrError(error.message));
  return done(v.value.decision === "approve" ? "hr_approved" : "hr_rejected");
}

export async function cancelLeave(formData: FormData) {
  const v = parseIdForm(Object.fromEntries(formData), "leaveId");
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("staff_leave_cancel", { p_leave: v.value });
  if (error) return fail(classifyHrError(error.message));
  return done("hr_cancelled");
}
