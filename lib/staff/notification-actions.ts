"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { staffClient } from "./action-helpers";
import { parseCategory } from "./notifications";

const PAGE = "/app/notifications";

/** Marks one notice read for the signed-in person only. Nobody else's read state changes. */
export async function markNotificationRead(formData: FormData) {
  const parsed = z.object({ id: z.guid(), next: z.string().optional() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return redirect(`${PAGE}?err=bad_request`);
  const supabase = await staffClient();
  await supabase.rpc("mark_notification_read", { p_id: parsed.data.id });
  revalidatePath("/app", "layout");
  // Following a notice marks it read, then goes where it points (an in-app path only).
  if (parsed.data.next && /^\/app(\/[A-Za-z0-9_-]+)*$/.test(parsed.data.next)) redirect(parsed.data.next);
}

/** Marks everything the person can see read, or only one category when one is chosen. */
export async function markAllNotificationsRead(formData: FormData) {
  const category = parseCategory(String(formData.get("category") ?? ""));
  const supabase = await staffClient();
  await supabase.rpc("mark_notifications_read", { p_category: category });
  revalidatePath("/app", "layout");
}
