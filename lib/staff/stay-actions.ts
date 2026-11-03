"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyStayError, guestsPayload, parseStayForm, resultCode } from "./stay-edit";

/**
 * Changes a booking's dates and how many adults and children are in each room (migration 033). Runs as the signed-in
 * person, never the service role, so the database decides who may do it (`reservation.modify`), whether the booking
 * can still change (confirmed, nobody arrived, nothing paid, no live invoice) and whether the rooms are free. The form
 * carries an idempotency key made when the page rendered, so a double click returns the first answer. All or nothing:
 * if any room cannot be held for the new dates, the booking is exactly as it was.
 */

const LIST = "/app/reservations";
const ids = z.object({ reservationId: z.guid(), idempotencyKey: z.string().min(8).max(100) });

export async function editStay(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const head = ids.safeParse(raw);
  if (!head.success) return back(LIST, { err: "bad_request" });
  const page = `${LIST}/${head.data.reservationId}`;

  const v = parseStayForm(raw);
  if (!v.ok) return back(page, { err: v.code });
  const e = v.value;

  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("update_reservation_stay", {
    p_reservation_id: head.data.reservationId, p_arrival: e.arrival, p_departure: e.departure,
    p_guests: guestsPayload(e.guests), p_reason: e.reason, p_idempotency_key: head.data.idempotencyKey,
  });
  if (error) return back(page, { err: classifyStayError(error.message) });

  revalidatePath(page);
  revalidatePath(`${page}/settlement`);
  revalidatePath(LIST);
  revalidatePath("/app/front-desk");
  revalidatePath("/app/rooms");
  return ok(page, resultCode(data));
}
