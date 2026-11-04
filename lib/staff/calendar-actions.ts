"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, staffClient } from "./action-helpers";
import { classifyRpcError } from "./refunds";
import { parseIsoDate } from "./reservations";
import { WINDOW_CHOICES } from "./room-calendar";

const CALENDAR = "/app/rooms/calendar";

/**
 * Moves a guest to another room by dragging a bar on the room calendar. The same transfer_room call as the booking page, run
 * as the signed-in person, so the database decides who may and whether the new room is free; this carries the request and
 * sends the person back to the same calendar window with a short result code.
 */
export async function moveStayFromCalendar(formData: FormData) {
  const parsed = z.object({
    reservationRoomId: z.guid(), newRoomId: z.guid(), idempotencyKey: z.string().min(8).max(100),
    effective: z.string().max(10), reason: z.string().max(500),
    property: z.guid(), from: z.string().max(10), days: z.string().max(3),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(CALENDAR, { err: "bad_request" });

  const d = parsed.data;
  const from = parseIsoDate(d.from);
  const days = (WINDOW_CHOICES as readonly number[]).includes(Number(d.days)) ? d.days : "14";
  const view = { property: d.property, ...(from ? { from } : {}), days };
  const effective = parseIsoDate(d.effective);
  if (!effective) return back(CALENDAR, { ...view, err: "bad_request" });
  if (!d.reason.trim()) return back(CALENDAR, { ...view, err: "reason_required" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("transfer_room", {
    p_reservation_room_id: d.reservationRoomId, p_new_room_id: d.newRoomId,
    p_effective: effective, p_reason: d.reason.trim(), p_idempotency_key: d.idempotencyKey,
  });
  if (error) {
    // Here "unavailable" means the guest stays where they are, not that a booking failed.
    const c = classifyRpcError(error.message);
    return back(CALENDAR, { ...view, err: c.code === "room_unavailable" ? "transfer_unavailable" : c.code, ...(c.refundableMinor !== undefined ? { n: c.refundableMinor } : {}) });
  }
  revalidatePath(CALENDAR);
  revalidatePath("/app/rooms");
  revalidatePath("/app/front-desk");
  revalidatePath("/app/reservations/[id]", "page");
  return back(CALENDAR, { ...view, ok: "calendar_moved" });
}
