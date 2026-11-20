"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import {
  classifyInvError,
  parseCountForm,
  parseItemForm,
  parseOutForm,
  parsePurchaseForm,
  parseRecipeForm,
  parseSupplierForm,
  type InvErrorCode,
  type InvOkCode,
} from "./inventory";

/**
 * Stock and purchasing actions (migration 150). Each runs as the signed-in person; the database checks the permission (inventory.use to record
 * use, waste and counts; inventory.manage for items, suppliers, recipes and purchases), the inventory flag, and the quantities, and answers with
 * a refusal that is shown as a short code, never as database text. A form carries a key made when the page was drawn, so a double tap repeats
 * the first answer.
 */
const DESK = "/app/inventory";
const BUY = "/app/inventory/purchases";
const COUNT = "/app/inventory/count";
const SETUP = "/app/settings/inventory";

const fail = (path: string, code: InvErrorCode): never => back(path, { inverr: code });
const done = (path: string, code: InvOkCode): never => back(path, { inv: code });

export async function saveStockItem(formData: FormData) {
  const v = parseItemForm(Object.fromEntries(formData));
  if (!v.ok) return fail(SETUP, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("stock_save_item", {
    p_property: v.value.propertyId,
    p_item: v.value.itemId as string,
    p_name: v.value.name,
    p_unit: v.value.unit,
    p_kind: v.value.kind,
    p_low: v.value.low,
    p_active: v.value.active,
  });
  if (error) return fail(SETUP, classifyInvError(error.message));
  revalidatePath(SETUP);
  revalidatePath(DESK);
  return done(SETUP, "inv_saved");
}

export async function saveStockSupplier(formData: FormData) {
  const v = parseSupplierForm(Object.fromEntries(formData));
  if (!v.ok) return fail(SETUP, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("stock_save_supplier", {
    p_property: v.value.propertyId,
    p_supplier: v.value.supplierId as string,
    p_name: v.value.name,
    p_phone: v.value.phone as string,
    p_note: v.value.note as string,
    p_active: v.value.active,
  });
  if (error) return fail(SETUP, classifyInvError(error.message));
  revalidatePath(SETUP);
  return done(SETUP, "inv_saved");
}

export async function saveStockRecipe(formData: FormData) {
  const v = parseRecipeForm(Object.fromEntries(formData));
  if (!v.ok) return fail(SETUP, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("stock_set_recipe", { p_pos_item: v.value.posItemId, p_lines: v.value.lines });
  if (error) return fail(SETUP, classifyInvError(error.message));
  revalidatePath(SETUP);
  return done(SETUP, "inv_recipe");
}

export async function recordStockOut(formData: FormData) {
  const v = parseOutForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("stock_record_out", {
    p_item: v.value.itemId,
    p_kind: v.value.kind,
    p_quantity: v.value.quantity,
    p_reason: v.value.reason,
    p_note: v.value.note as string,
    p_key: v.value.key,
  });
  if (error) return fail(DESK, classifyInvError(error.message));
  revalidatePath(DESK);
  return done(DESK, "inv_out");
}

export async function recordStockPurchase(formData: FormData) {
  const v = parsePurchaseForm(Object.fromEntries(formData));
  if (!v.ok) return fail(BUY, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("stock_record_purchase", {
    p_property: v.value.propertyId,
    p_supplier: v.value.supplierId as string,
    p_reference: v.value.reference as string,
    p_note: v.value.note as string,
    p_lines: v.value.lines,
    p_key: v.value.key,
  });
  if (error) return fail(BUY, classifyInvError(error.message));
  revalidatePath(BUY);
  revalidatePath(DESK);
  return done(BUY, "inv_purchase");
}

export async function saveStockCount(formData: FormData) {
  const v = parseCountForm(Object.fromEntries(formData));
  if (!v.ok) return fail(COUNT, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("stock_count", {
    p_property: v.value.propertyId,
    p_counts: v.value.counts,
    p_note: v.value.note as string,
    p_key: v.value.key,
  });
  if (error) return fail(COUNT, classifyInvError(error.message));
  revalidatePath(DESK);
  revalidatePath(COUNT);
  return done(DESK, "inv_count");
}
