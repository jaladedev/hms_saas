import "server-only";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "./active-property";
import { pickProperty } from "./property-choice";

export type SvcProperty = { id: string; name: string; currency: string; timezone: string };
export type SvcCan = { book: boolean; manage: boolean; report: boolean };

/** The hotel a services page shows and what this person may do there, for the screens only. The database checks every action and read again. */
export async function loadServicesContext(requested: string | undefined) {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, currency, timezone").order("name");
  const all = (propQ.data ?? []) as SvcProperty[];
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const { data } = await supabase.rpc("svc_can_read", { p_property: p.id });
        return data === true ? p : null;
      }),
    )
  ).filter((p): p is SvcProperty => p !== null);
  const property = pickProperty(allowed, requested, await rememberedProperty());
  let can: SvcCan = { book: false, manage: false, report: false };
  if (property) {
    const has = async (permission: string) =>
      (await supabase.rpc("has_permission", { p_property: property.id, p_permission: permission })).data === true;
    const [book, manage, report] = await Promise.all([has("services.book"), has("services.manage"), has("report.view")]);
    can = { book: book || manage, manage, report };
  }
  return { supabase, loadFailed: Boolean(propQ.error), property, can };
}
