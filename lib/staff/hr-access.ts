import "server-only";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "./active-property";
import { pickProperty } from "./property-choice";

export type HrProperty = { id: string; name: string; timezone: string };
export type HrCan = { manage: boolean };

/** The hotel the shifts page shows and whether this person manages the rota there, for the screens only. The database checks every action and read again. */
export async function loadHrContext(requested: string | undefined) {
  const supabase = await createClient();
  const [propQ, authQ] = await Promise.all([
    supabase.from("properties").select("id, name, timezone").order("name"),
    supabase.auth.getUser(),
  ]);
  const userId = authQ.data.user?.id ?? "";
  const all = (propQ.data ?? []) as HrProperty[];
  const rows = await Promise.all(
    all.map(async (p) => {
      const [staff, manage] = await Promise.all([
        supabase.rpc("hr_is_staff", { p_property: p.id, p_user: userId }),
        supabase.rpc("has_permission", { p_property: p.id, p_permission: "hr.manage" }),
      ]);
      return staff.data === true || manage.data === true ? { p, manage: manage.data === true } : null;
    }),
  );
  const allowed = rows.filter((r): r is { p: HrProperty; manage: boolean } => r !== null);
  const property = pickProperty(
    allowed.map((r) => r.p),
    requested,
    await rememberedProperty(),
  );
  const can: HrCan = { manage: allowed.find((r) => r.p.id === property?.id)?.manage ?? false };
  return { supabase, userId, loadFailed: Boolean(propQ.error || authQ.error), property, can };
}
