import "server-only";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "./active-property";
import { pickProperty } from "./property-choice";

export type PosProperty = { id: string; name: string; currency: string; timezone: string };
export type PosCan = { sell: boolean; manage: boolean; folio: boolean; report: boolean };

/**
 * The hotel a restaurant page shows and what this person may do there, for the screens only (which buttons to draw). Every action and
 * every read is checked again in the database, so a wrong answer here can hide a button but never grant anything.
 */
export async function loadPosContext(requested: string | undefined) {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, currency, timezone").order("name");
  const all = (propQ.data ?? []) as PosProperty[];
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const { data } = await supabase.rpc("pos_can_read", { p_property: p.id });
        return data === true ? p : null;
      }),
    )
  ).filter((p): p is PosProperty => p !== null);
  const property = pickProperty(allowed, requested, await rememberedProperty());
  let can: PosCan = { sell: false, manage: false, folio: false, report: false };
  if (property) {
    const has = async (permission: string) =>
      (await supabase.rpc("has_permission", { p_property: property.id, p_permission: permission })).data === true;
    const [sell, manage, folio, report] = await Promise.all([has("pos.sell"), has("pos.manage"), has("folio.charge"), has("report.view")]);
    can = { sell, manage, folio, report };
  }
  return { supabase, loadFailed: Boolean(propQ.error), property, can };
}
