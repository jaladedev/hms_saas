"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { classifyTaxError, parseToggle } from "./tax-rules";

/**
 * Tax rule actions. They run as the signed-in person; the table's row-level security allows an update only to
 * people with property.configure at that rule's property, so a refusal from the database is final. Only the one
 * column that decides whether extras are taxed is written. Posted charges keep the tax they were posted with
 * (migration 027 stores it on the charge), and the change is recorded in the audit log by migration 028.
 */

const PAGE = "/app/settings/tax";

export async function setExtrasTax(formData: FormData) {
  const parsed = parseToggle(Object.fromEntries(formData));
  if (!parsed.ok) return back(PAGE, { err: "bad_request" });

  const supabase = await staffClient();
  // Select the changed row back: a rule that is not visible, or not changeable by this person, updates zero rows
  // without an error, and that must not be shown as a success.
  const { data, error } = await supabase.from("tax_rules").update({ applies_to_charges: parsed.apply }).eq("id", parsed.ruleId).select("id");
  if (error) return back(PAGE, { err: classifyTaxError(error) });
  if (!data || data.length === 0) return back(PAGE, { err: "tax_not_found" });
  revalidatePath(PAGE);
  return ok(PAGE, parsed.apply ? "tax_extras_on" : "tax_extras_off");
}
