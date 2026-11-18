"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, staffClient } from "./action-helpers";
import { classifyNightAuditError, isDay } from "./night-audit";
import { classifyRpcError } from "./refunds";

const PAGE = "/app/night-audit";

/**
 * Closes one day at one hotel. The form carries an idempotency key made when the page rendered, so a double click or a retry
 * returns the first answer. The database checks day.close at that hotel, refuses a future day, and wants a note when items are
 * still open; the page only words what comes back.
 */
export async function closeDay(formData: FormData) {
  const parsed = z
    .object({
      property: z.guid(),
      day: z.string().refine(isDay),
      note: z.string().max(500).optional(),
      idempotencyKey: z.string().min(8).max(100),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const { property, day, idempotencyKey } = parsed.data;
  const note = parsed.data.note?.trim() || null;

  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("close_day", {
    p_property: property,
    p_day: day,
    p_override_note: note as string,
    p_idempotency_key: idempotencyKey,
  });
  if (error) {
    const code = classifyNightAuditError(error.message) ?? classifyRpcError(error.message).code;
    return back(PAGE, { property, day, err: code });
  }
  revalidatePath(PAGE);
  const open = (data as { open_items?: unknown } | null)?.open_items;
  return back(PAGE, { property, day, ok: typeof open === "number" && open > 0 ? "na_closed_open" : "na_closed_clean" });
}
