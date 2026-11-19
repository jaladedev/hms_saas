"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import {
  classifyPosError,
  parseCategoryForm,
  parseItemForm,
  parseLineForm,
  parseOpenOrderForm,
  parsePayForm,
  parsePlaceForm,
  parsePostForm,
  parseStatusForm,
  parseVoidForm,
  type PosErrorCode,
  type PosOkCode,
} from "./pos";

/**
 * Restaurant and bar actions (migration 148). Each runs as the signed-in person; the database checks the permission (pos.view, pos.sell,
 * pos.manage, and folio.charge for a room bill), the restaurant_pos flag, the order's state and the money, and answers with a refusal that is
 * shown as a short code, never as database text. A form carries a key made when the page was drawn, so a double tap repeats the first answer.
 */
const DESK = "/app/pos";
const KITCHEN = "/app/pos/kitchen";
const SETUP = "/app/settings/pos";
const orderPath = (id: string) => `${DESK}/orders/${id}`;

const fail = (path: string, code: PosErrorCode): never => back(path, { poserr: code });
const done = (path: string, code: PosOkCode): never => back(path, { pos: code });

// ---- menu and places (pos.manage) ---------------------------------------------------------------

export async function savePosCategory(formData: FormData) {
  const v = parseCategoryForm(Object.fromEntries(formData));
  if (!v.ok) return fail(SETUP, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_save_category", {
    p_property: v.value.propertyId,
    p_category: v.value.categoryId as string,
    p_name: v.value.name,
    p_sort: v.value.sort,
    p_active: v.value.active,
  });
  if (error) return fail(SETUP, classifyPosError(error.message));
  revalidatePath(SETUP);
  return done(SETUP, "pos_saved");
}

export async function savePosItem(formData: FormData) {
  const v = parseItemForm(Object.fromEntries(formData));
  if (!v.ok) return fail(SETUP, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_save_item", {
    p_property: v.value.propertyId,
    p_item: v.value.itemId as string,
    p_category: v.value.categoryId,
    p_name: v.value.name,
    p_price: v.value.priceMinor,
    p_sort: v.value.sort,
    p_active: v.value.active,
  });
  if (error) return fail(SETUP, classifyPosError(error.message));
  revalidatePath(SETUP);
  return done(SETUP, "pos_saved");
}

export async function savePosPlace(formData: FormData) {
  const v = parsePlaceForm(Object.fromEntries(formData));
  if (!v.ok) return fail(SETUP, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_save_place", {
    p_property: v.value.propertyId,
    p_place: v.value.placeId as string,
    p_name: v.value.name,
    p_kind: v.value.kind,
    p_active: v.value.active,
  });
  if (error) return fail(SETUP, classifyPosError(error.message));
  revalidatePath(SETUP);
  return done(SETUP, "pos_saved");
}

// ---- orders (pos.sell) ------------------------------------------------------------------------------

export async function openPosOrder(formData: FormData) {
  const v = parseOpenOrderForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("pos_open_order", {
    p_property: v.value.propertyId,
    p_place: v.value.placeId,
    p_guest_label: v.value.label as string,
    p_key: v.value.key,
  });
  if (error) return fail(DESK, classifyPosError(error.message));
  const id = (data as { order_id?: unknown } | null)?.order_id;
  revalidatePath(DESK);
  if (typeof id !== "string") return done(DESK, "pos_opened");
  return done(orderPath(id), "pos_opened");
}

export async function addPosLine(formData: FormData) {
  const v = parseLineForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const path = orderPath(v.value.orderId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_add_line", {
    p_order: v.value.orderId,
    p_item: v.value.itemId,
    p_quantity: v.value.quantity,
    p_note: v.value.note as string,
    p_key: v.value.key,
  });
  if (error) return fail(path, classifyPosError(error.message));
  revalidatePath(path);
  return done(path, "pos_line_added");
}

/** One kitchen step (or a cancel) on one line, from the order page or the kitchen screen. */
export async function setPosLineStatus(formData: FormData) {
  const v = parseStatusForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const path = v.value.back === "kitchen" || !v.value.orderId ? KITCHEN : orderPath(v.value.orderId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_set_line_status", { p_line: v.value.lineId, p_status: v.value.status });
  if (error) return fail(path, classifyPosError(error.message));
  revalidatePath(path);
  return done(path, "pos_status");
}

export async function voidPosOrder(formData: FormData) {
  const v = parseVoidForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const path = orderPath(v.value.orderId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_void_order", { p_order: v.value.orderId, p_reason: v.value.reason });
  if (error) return fail(path, classifyPosError(error.message));
  revalidatePath(DESK);
  return done(path, "pos_voided");
}

export async function payPosOrder(formData: FormData) {
  const v = parsePayForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const path = orderPath(v.value.orderId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_pay_order", {
    p_order: v.value.orderId,
    p_method: v.value.method,
    p_reference: v.value.reference as string,
    p_key: v.value.key,
  });
  if (error) return fail(path, classifyPosError(error.message));
  revalidatePath(DESK);
  return done(path, "pos_paid");
}

export async function postPosOrderToRoom(formData: FormData) {
  const v = parsePostForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const path = orderPath(v.value.orderId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pos_post_to_room", {
    p_order: v.value.orderId,
    p_reservation: v.value.reservationId,
    p_key: v.value.key,
  });
  if (error) return fail(path, classifyPosError(error.message));
  revalidatePath(DESK);
  return done(path, "pos_posted");
}
