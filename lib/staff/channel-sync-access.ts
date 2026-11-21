import "server-only";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "./active-property";
import { pickProperty } from "./property-choice";

export type ChannelProperty = { id: string; name: string; timezone: string; currency: string };

/** The hotel the channels page shows, for the screens only. The database checks every action and read again. */
export async function loadChannelsContext(requested: string | undefined) {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, timezone, currency").order("name");
  const all = (propQ.data ?? []) as ChannelProperty[];
  const allowed = (
    await Promise.all(
      all.map(async (p) =>
        (await supabase.rpc("has_permission", { p_property: p.id, p_permission: "channels.manage" })).data === true ? p : null,
      ),
    )
  ).filter((p): p is ChannelProperty => p !== null);
  const property = pickProperty(allowed, requested, await rememberedProperty());
  return { supabase, loadFailed: Boolean(propQ.error), property };
}
