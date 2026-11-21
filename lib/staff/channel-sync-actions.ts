"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import {
  CHANNEL_ERROR_MESSAGES,
  classifyChannelError,
  classifyModifyError,
  parseApplyForm,
  parseBookingIdForm,
  parseConnectionForm,
  parseMapForm,
  parseResolveForm,
  parseStatusForm,
  parseUnmapForm,
  type ChannelErrorCode,
  type ChannelOkCode,
  type CreateState,
} from "./channel-sync";

/**
 * Channel manager actions (migration 171). Each runs as the signed-in person; the database checks channels.manage and the channel_manager flag.
 * A new connection key is returned to the form that asked and shown once there; it is never put in a URL, a cookie or a log.
 */
const PAGE = "/app/channels";
const fail = (code: ChannelErrorCode): never => back(PAGE, { cherr: code });
const done = (code: ChannelOkCode): never => {
  revalidatePath(PAGE);
  return back(PAGE, { ch: code });
};

export async function createConnection(_prev: CreateState, formData: FormData): Promise<CreateState> {
  const v = parseConnectionForm(Object.fromEntries(formData));
  if (!v.ok) return { error: CHANNEL_ERROR_MESSAGES[v.code], secret: null };
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("channel_connection_create", {
    p_property: v.value.propertyId,
    p_channel: v.value.channel,
    p_label: v.value.label,
    p_collects: v.value.collects,
  });
  if (error) return { error: CHANNEL_ERROR_MESSAGES[classifyChannelError(error.message)], secret: null };
  revalidatePath(PAGE);
  const key = data && typeof data === "object" && "key" in data ? String((data as { key: unknown }).key) : "";
  return key ? { error: null, secret: { label: "Connection key", value: key } } : { error: CHANNEL_ERROR_MESSAGES.ch_failed, secret: null };
}

export async function setConnectionStatus(formData: FormData) {
  const v = parseStatusForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("channel_connection_set", { p_connection: v.value.connectionId, p_status: v.value.status });
  if (error) return fail(classifyChannelError(error.message));
  return done("ch_status");
}

export async function saveMapping(formData: FormData) {
  const v = parseMapForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("channel_map_set", {
    p_connection: v.value.connectionId,
    p_external: v.value.code,
    p_room_type: v.value.roomTypeId,
  });
  if (error) return fail(classifyChannelError(error.message));
  return done("ch_map");
}

export async function removeMapping(formData: FormData) {
  const v = parseUnmapForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("channel_map_remove", { p_connection: v.value.connectionId, p_external: v.value.code });
  if (error) return fail(classifyChannelError(error.message));
  return done("ch_unmap");
}

export async function retryBooking(formData: FormData) {
  const v = parseBookingIdForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("channel_retry", { p_id: v.value });
  if (error) return fail(classifyChannelError(error.message));
  const status = data && typeof data === "object" && "status" in data ? (data as { status: unknown }).status : "";
  return done(status === "imported" ? "ch_retry_imported" : "ch_retry_failed");
}

export async function recordChannelPayment(formData: FormData) {
  const v = parseBookingIdForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("channel_record_payment", { p_id: v.value });
  if (error) return fail(classifyChannelError(error.message));
  return done("ch_paid");
}

export async function applyChannelChange(formData: FormData) {
  const v = parseApplyForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("channel_modify_apply", { p_id: v.value.bookingId, p_key: v.value.key });
  if (error) return fail(classifyModifyError(error.message));
  revalidatePath("/app/reservations");
  return done("ch_mod_applied");
}

export async function resolveBooking(formData: FormData) {
  const v = parseResolveForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("channel_resolve", { p_id: v.value.bookingId, p_note: v.value.note });
  if (error) return fail(classifyChannelError(error.message));
  return done("ch_resolved");
}
