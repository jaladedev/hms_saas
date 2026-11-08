"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyGuestLinkError, guestLinkResultCode, parseGuestLinkReason } from "./guest-link";

/**
 * Ends every guest link issued for a booking so far (migration 066) and emails the guest a new one when they have an address.
 * Runs as the signed-in person, so the database decides who may (`reservation.modify`). The form carries an idempotency key
 * made when the page rendered, so a double click returns the first answer.
 */

const LIST = "/app/reservations";
const ids = z.object({ reservationId: z.guid(), idempotencyKey: z.string().min(8).max(100) });

export async function resetGuestLinks(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const head = ids.safeParse(raw);
  if (!head.success) return back(LIST, { err: "bad_request" });
  const page = `${LIST}/${head.data.reservationId}`;

  const v = parseGuestLinkReason(raw.reason);
  if (!v.ok) return back(page, { err: v.code });

  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("reset_guest_links", {
    p_reservation_id: head.data.reservationId, p_reason: v.reason, p_idempotency_key: head.data.idempotencyKey,
  });
  if (error) return back(page, { err: classifyGuestLinkError(error.message) });

  revalidatePath(page);
  return ok(page, guestLinkResultCode(data));
}
