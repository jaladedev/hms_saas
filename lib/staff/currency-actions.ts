"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import { classifyFxError, parseRateForm, type FxErrorCode } from "./currency-rates";

/** Saves one exchange rate (migration 163). Runs as the signed-in person; the database checks property.configure and the multi_currency flag. */
const PAGE = "/app/settings/currency";
const fail = (code: FxErrorCode): never => back(PAGE, { fxerr: code });

export async function saveRate(formData: FormData) {
  const v = parseRateForm(Object.fromEntries(formData));
  if (!v.ok) return fail(v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("fx_rate_set", {
    p_property: v.value.propertyId,
    p_from: v.value.from,
    p_to: v.value.to,
    p_date: v.value.date,
    p_rate: Number(v.value.rate),
    p_note: v.value.note,
  });
  if (error) return fail(classifyFxError(error.message));
  revalidatePath(PAGE);
  return back(PAGE, { fx: "fx_saved" });
}
