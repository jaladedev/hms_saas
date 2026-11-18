import { rememberedProperty } from "./active-property";
import { pickProperty } from "./property-choice";
import { createClient } from "@/lib/supabase/server";

export type EventProperty = { id: string; name: string; timezone: string; currency: string };

/** The hotels this person may use for events under one permission, and the one the page shows. The database checks again on every read and write. */
export async function eventProperties(permission: "event.view" | "event.manage", requested: string | undefined) {
  const supabase = await createClient();
  const { data } = await supabase.from("properties").select("id, name, timezone, currency").eq("status", "active").order("name");
  const all = (data ?? []) as EventProperty[];
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const { data: ok } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: permission });
        return ok === true ? p : null;
      }),
    )
  ).filter((p): p is EventProperty => p !== null);
  const chosen = pickProperty(allowed, requested, await rememberedProperty());
  return { supabase, allowed, chosen };
}

/** Payments less refunds, from the ledger rows. */
export function netPaid(rows: { payment_kind: string; amount_minor: number }[]): number {
  return rows.reduce((s, r) => s + (r.payment_kind === "refund" ? -r.amount_minor : r.amount_minor), 0);
}
