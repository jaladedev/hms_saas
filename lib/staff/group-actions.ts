"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import { parseCreditApplyForm, parseCreditDepositForm, parseCreditWithdrawForm } from "./company-credit";
import {
  classifyGroupError,
  parseCreateGroupForm,
  parseGroupId,
  parseIssueInvoiceForm,
  parseApplyRateForm,
  parseCompanyCreateForm,
  parseCompanyRateForm,
  parseAutoRateForm,
  parseHoldForm,
  parseCompanyRateRemoveForm,
  parseCompanyUpdateForm,
  parseGroupPaymentForm,
  parseLinkForm,
  parseReverseGroupPaymentForm,
  parseSetCompanyForm,
  parsePaidInvoiceForm,
  parseVoidInvoiceForm,
  parseRoomingForm,
  parseRoomingRemoveForm,
  parseUnitForm,
  parseUpdateGroupForm,
  type GroupErrorCode,
  type GroupOkCode,
} from "./groups";

/**
 * Group booking actions (migration 150). Each runs as the signed-in person; the database requires group.manage at that hotel and the
 * group_bookings flag, holds the rooms all or nothing, and answers with a refusal shown as a short code, never as database text.
 * The create form carries a key made when the page was drawn, so a double tap repeats the first answer.
 */
const LIST = "/app/groups";
const COMPANIES = "/app/groups/companies";
const detail = (id: string) => `${LIST}/${id}`;
const fail = (path: string, code: GroupErrorCode): never => back(path, { grouperr: code });
const done = (path: string, code: GroupOkCode): never => back(path, { group: code });

export async function createGroup(formData: FormData) {
  const v = parseCreateGroupForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const f = v.value;
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("create_group", {
    p_property: f.propertyId,
    p_name: f.name,
    p_company: f.company as string,
    p_contact_name: f.contactName,
    p_contact_phone: f.contactPhone as string,
    p_contact_email: f.contactEmail as string,
    p_arrival: f.arrival,
    p_departure: f.departure,
    p_release: f.release,
    p_notes: f.notes as string,
    p_rooms: f.rooms,
    p_key: f.key,
  });
  if (error) return fail(LIST, classifyGroupError(error.message));
  revalidatePath(LIST);
  const id = (data as { group_id?: unknown } | null)?.group_id;
  return done(typeof id === "string" ? detail(id) : LIST, "group_created");
}

export async function updateGroup(formData: FormData) {
  const v = parseUpdateGroupForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const f = v.value;
  const path = detail(f.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_group", {
    p_group: f.groupId,
    p_company: f.company as string,
    p_contact_name: f.contactName,
    p_contact_phone: f.contactPhone as string,
    p_contact_email: f.contactEmail as string,
    p_release: f.release,
    p_notes: f.notes as string,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_updated");
}

export async function cancelGroup(formData: FormData) {
  const id = parseGroupId(formData.get("groupId"));
  if (!id) return fail(LIST, "group_invalid");
  const supabase = await staffClient();
  const { error } = await supabase.rpc("cancel_group", { p_group: id });
  if (error) return fail(detail(id), classifyGroupError(error.message));
  revalidatePath(LIST);
  revalidatePath(detail(id));
  return done(detail(id), "group_cancelled");
}

export async function useGroupRoom(formData: FormData) {
  const v = parseUnitForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("use_group_unit", { p_group: v.value.groupId, p_room_type: v.value.roomTypeId });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_unit_used");
}

export async function addRoomingEntry(formData: FormData) {
  const v = parseRoomingForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("add_rooming_entry", {
    p_group: v.value.groupId,
    p_guest: v.value.guest,
    p_room_type: v.value.roomTypeId as string,
    p_notes: v.value.notes as string,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_rooming_added");
}

export async function removeRoomingEntry(formData: FormData) {
  const v = parseRoomingRemoveForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("remove_rooming_entry", { p_entry: v.value.entryId });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_rooming_removed");
}

export async function linkRoomingBooking(formData: FormData) {
  const v = parseLinkForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("link_rooming_reservation", { p_entry: v.value.entryId, p_reference: v.value.reference });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_booking_linked");
}

export async function unlinkRoomingBooking(formData: FormData) {
  const v = parseRoomingRemoveForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("unlink_rooming_reservation", { p_entry: v.value.entryId });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_booking_unlinked");
}

export async function issueGroupInvoice(formData: FormData) {
  const v = parseIssueInvoiceForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("issue_group_invoice", { p_group: v.value.groupId, p_due: v.value.due, p_key: v.value.key });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_invoice_issued");
}

export async function voidGroupInvoice(formData: FormData) {
  const v = parseVoidInvoiceForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("void_group_invoice", { p_invoice: v.value.invoiceId, p_reason: v.value.reason });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_invoice_voided");
}

export async function markGroupInvoicePaid(formData: FormData) {
  const v = parsePaidInvoiceForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("mark_group_invoice_paid", {
    p_invoice: v.value.invoiceId,
    p_method: v.value.method,
    p_reference: v.value.reference as string,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_invoice_paid");
}

export async function createCompany(formData: FormData) {
  const v = parseCompanyCreateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const f = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_create", {
    p_property: f.propertyId,
    p_name: f.name,
    p_contact: f.contact,
    p_email: f.email as string,
    p_phone: f.phone as string,
    p_credit_days: f.creditDays,
    p_percent: f.percent,
    p_notes: f.notes as string,
    p_credit_limit_minor: f.creditLimitMinor as number,
  });
  if (error) return fail(COMPANIES, error.message.includes("NOT_FOUND") ? "company_forbidden" : classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, "company_created");
}

export async function updateCompany(formData: FormData) {
  const v = parseCompanyUpdateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const f = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_update", {
    p_company: f.companyId,
    p_contact: f.contact,
    p_email: f.email as string,
    p_phone: f.phone as string,
    p_credit_days: f.creditDays,
    p_percent: f.percent,
    p_notes: f.notes as string,
    p_status: f.status,
    p_credit_limit_minor: f.creditLimitMinor as number,
  });
  if (error) return fail(COMPANIES, error.message.includes("NOT_FOUND") ? "company_forbidden" : classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, "company_updated");
}

export async function setGroupCompany(formData: FormData) {
  const v = parseSetCompanyForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_group_company", { p_group: v.value.groupId, p_company: v.value.companyId as string });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_company_set");
}

export async function applyCompanyRate(formData: FormData) {
  const v = parseApplyRateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("apply_company_rate_to_group", { p_group: v.value.groupId, p_key: v.value.key });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  const r = (data ?? {}) as { applied?: unknown; skipped?: unknown };
  return back(path, { group: "group_rate_applied", applied: String(Number(r.applied) || 0), skipped: String(Number(r.skipped) || 0) });
}

export async function recordGroupPayment(formData: FormData) {
  const v = parseGroupPaymentForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const f = v.value;
  const path = detail(f.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("record_group_payment", {
    p_group: f.groupId,
    p_amount_minor: f.amountMinor,
    p_method: f.method,
    p_reference: f.reference as string,
    p_note: f.note as string,
    p_allocations: (f.allocations ?? null) as never,
    p_key: f.key,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_payment_recorded");
}

export async function reverseGroupPayment(formData: FormData) {
  const v = parseReverseGroupPaymentForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("reverse_group_payment", {
    p_group_payment: v.value.paymentId,
    p_reason: v.value.reason,
    p_key: v.value.key,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_payment_reversed");
}

export async function setCompanyRate(formData: FormData) {
  const v = parseCompanyRateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_rate_set", {
    p_company: v.value.companyId,
    p_room_type: v.value.roomTypeId,
    p_mode: v.value.mode,
    p_value: v.value.value,
  });
  if (error)
    return fail(
      COMPANIES,
      error.message.includes("NOT_FOUND")
        ? "company_forbidden"
        : error.message.includes("details")
          ? "company_rate_invalid"
          : classifyGroupError(error.message),
    );
  revalidatePath(COMPANIES);
  return done(COMPANIES, "company_rate_saved");
}

export async function removeCompanyRate(formData: FormData) {
  const v = parseCompanyRateRemoveForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_rate_remove", { p_company: v.value.companyId, p_room_type: v.value.roomTypeId });
  if (error) return fail(COMPANIES, error.message.includes("NOT_FOUND") ? "company_forbidden" : classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, "company_rate_removed");
}

export async function setCompanyHold(formData: FormData) {
  const v = parseHoldForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_set_hold", { p_company: v.value.companyId, p_days: v.value.days as number });
  if (error) return fail(COMPANIES, error.message.includes("NOT_FOUND") ? "company_forbidden" : classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, "company_hold_set");
}

export async function setCompanySmsReminders(formData: FormData) {
  const v = parseAutoRateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_set_sms_reminders", { p_company: v.value.companyId, p_on: v.value.on });
  if (error) return fail(COMPANIES, error.message.includes("NOT_FOUND") ? "company_forbidden" : classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, v.value.on ? "company_sms_reminders_on" : "company_sms_reminders_off");
}

export async function setCompanyReminders(formData: FormData) {
  const v = parseAutoRateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_set_reminders", { p_company: v.value.companyId, p_on: v.value.on });
  if (error) return fail(COMPANIES, error.message.includes("NOT_FOUND") ? "company_forbidden" : classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, v.value.on ? "company_reminders_on" : "company_reminders_off");
}

export async function setCompanyAutoRate(formData: FormData) {
  const v = parseAutoRateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_set_auto_rate", { p_company: v.value.companyId, p_on: v.value.on });
  if (error) return fail(COMPANIES, error.message.includes("NOT_FOUND") ? "company_forbidden" : classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, v.value.on ? "company_auto_on" : "company_auto_off");
}

/** Money received from a company with no booking to pay yet; kept as its credit balance (migration 168). */
export async function depositCompanyCredit(formData: FormData) {
  const v = parseCreditDepositForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const f = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_credit_deposit", {
    p_company: f.companyId,
    p_amount_minor: f.amountMinor,
    p_method: f.method,
    p_reference: f.reference as string,
    p_note: f.note as string,
    p_key: f.key,
  });
  if (error) return fail(COMPANIES, classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, "credit_deposited");
}

/** Gives credit back to the company, or writes it off, with a reason. */
export async function withdrawCompanyCredit(formData: FormData) {
  const v = parseCreditWithdrawForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COMPANIES, v.code);
  const f = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_credit_withdraw", {
    p_company: f.companyId,
    p_amount_minor: f.amountMinor,
    p_reason: f.reason,
    p_key: f.key,
  });
  if (error) return fail(COMPANIES, classifyGroupError(error.message));
  revalidatePath(COMPANIES);
  return done(COMPANIES, "credit_withdrawn");
}

/** Pays part of a group's bill from its company's credit balance. */
export async function applyCompanyCredit(formData: FormData) {
  const v = parseCreditApplyForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("company_credit_apply", {
    p_group: v.value.groupId,
    p_amount_minor: v.value.amountMinor,
    p_key: v.value.key,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "credit_applied");
}
