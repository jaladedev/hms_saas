"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { drainNow } from "@/lib/email/server";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { requestBookingLink, requestHost } from "@/lib/guest-site/server";

const inputSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  email: z.string().trim().toLowerCase().email().max(254),
});

/**
 * Emails a fresh booking link when the reference and email match. The answer is the same whether or not
 * anything matched, so this cannot be used to discover bookings or addresses.
 */
export async function requestLinkAction(formData: FormData): Promise<void> {
  const input = inputSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!input.success) redirect("/booking/find?error=bad_request");

  const limit = await checkGuestLimits({ ip: ["link"], keyed: [{ rule: "linkEmail", value: input.data.email }] });
  if (!limit.allowed) redirect("/booking/find?error=rate_limited");

  const result = await requestBookingLink(await requestHost(), input.data.reference, input.data.email);
  if (result.ok && result.data) after(() => { drainNow(5).catch(() => {}); });
  redirect("/booking/find?sent=1");
}
