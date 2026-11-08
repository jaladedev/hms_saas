"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { parseExpectedCharge } from "@/lib/guest-site/cancel";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { cancelBooking, verifiedBookingId } from "@/lib/guest-site/server";

const inputSchema = z.object({ token: z.string().min(10).max(512), key: z.string().min(8).max(100), charge: z.string().max(20) });

/**
 * Cancels the booking behind the token. The guest confirms the charge they were shown; the database refuses if it is no
 * longer that amount, and the page then shows the new one. The key is per page render, so a double click cancels once.
 */
export async function cancelAction(formData: FormData): Promise<void> {
  const input = inputSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!input.success) redirect("/?error=bad_request");
  const { token, key } = input.data;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) redirect("/?error=bad_request");
  const here = `/booking/${token}/cancel`;
  const charge = parseExpectedCharge(input.data.charge);
  if (charge === null) redirect(`${here}?error=bad_request`);

  const limit = await checkGuestLimits({ ip: ["pay"], keyed: [{ rule: "cancelReservation", value: reservationId }] });
  if (!limit.allowed) redirect(`${here}?error=rate_limited`);

  const result = await cancelBooking(reservationId, charge, `gcancel:${reservationId}:${key}`);
  if (!result.ok) redirect(`${here}?error=${result.error.code}`);
  redirect(`/booking/${token}?cancelled=1`);
}
