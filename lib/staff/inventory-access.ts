import "server-only";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "./active-property";
import { pickProperty } from "./property-choice";

export type InvProperty = { id: string; name: string; currency: string; timezone: string };
export type InvCan = { use: boolean; manage: boolean; report: boolean; money: boolean };

/**
 * The hotel a stock page shows and what this person may do there, for the screens only (which buttons to draw). Every action and every read is
 * checked again in the database, so a wrong answer here can hide a button but never grant anything.
 */
export async function loadInventoryContext(requested: string | undefined) {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, currency, timezone").order("name");
  const all = (propQ.data ?? []) as InvProperty[];
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const { data } = await supabase.rpc("inv_can_read", { p_property: p.id });
        return data === true ? p : null;
      }),
    )
  ).filter((p): p is InvProperty => p !== null);
  const property = pickProperty(allowed, requested, await rememberedProperty());
  let can: InvCan = { use: false, manage: false, report: false, money: false };
  if (property) {
    const has = async (permission: string) =>
      (await supabase.rpc("has_permission", { p_property: property.id, p_permission: permission })).data === true;
    const [use, manage, report, money] = await Promise.all([
      has("inventory.use"),
      has("inventory.manage"),
      has("report.view"),
      supabase.rpc("can_view_money", { p_property: property.id }).then((r) => r.data === true),
    ]);
    can = { use: use || manage, manage, report, money };
  }
  return { supabase, loadFailed: Boolean(propQ.error), property, can };
}
