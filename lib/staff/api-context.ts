import "server-only";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "./active-property";
import { pickProperty } from "./property-choice";

export type ApiProperty = { id: string; name: string; timezone: string };

/** The hotel the API settings page shows. Only people with api.manage get one; the database checks every read and action again. */
export async function loadApiContext(requested: string | undefined) {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, timezone").order("name");
  const all = (propQ.data ?? []) as ApiProperty[];
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "api.manage" });
        return data === true ? p : null;
      }),
    )
  ).filter((p): p is ApiProperty => p !== null);
  return { supabase, loadFailed: Boolean(propQ.error), property: pickProperty(allowed, requested, await rememberedProperty()) };
}
