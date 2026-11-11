"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { parseReviewForm } from "@/lib/guest-site/reviews";
import { submitReview, verifiedBookingId } from "@/lib/guest-site/server";

const inputSchema = z.object({ token: z.string().min(10).max(512) });

/**
 * Stores the guest's review of the stay behind the signed booking link. The database accepts it only once the booking is checked out
 * and only once per booking; the hotel approves it before anyone else sees it.
 */
export async function reviewAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const input = inputSchema.safeParse(raw);
  if (!input.success) redirect("/?error=bad_request");
  const { token } = input.data;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) redirect("/?error=bad_request");
  const here = `/booking/${token}/review`;

  const form = parseReviewForm(raw);
  if ("error" in form) redirect(`${here}?error=${form.error}`);

  const limit = await checkGuestLimits({ ip: ["pay"], keyed: [{ rule: "submitReview", value: reservationId }] });
  if (!limit.allowed) redirect(`${here}?error=rate_limited`);

  const result = await submitReview(reservationId, form.rating, form.comment);
  if (!result.ok) redirect(`${here}?error=${result.error.code}`);
  redirect(`/booking/${token}?reviewed=1`);
}
