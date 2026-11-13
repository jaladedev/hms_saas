"use server";

import { redirect } from "next/navigation";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { stayQuery } from "@/lib/guest-site/params";
import { joinWaitlist, requestHost } from "@/lib/guest-site/server";
import { parseWaitlistForm } from "@/lib/guest-site/waitlist";

/**
 * Adds the guest to the hotel's waiting list for a sold out room type and goes back to their search. The hotel contacts them itself
 * if a room frees up; nothing is emailed from here.
 */
export async function joinWaitlistAction(formData: FormData): Promise<void> {
  const form = parseWaitlistForm(Object.fromEntries(formData.entries()));
  if (!form.ok) redirect(`/?error=${form.error}`);
  const { stay, roomTypeId, name, email, phone } = form.value;
  const here = `/?${stayQuery(stay)}`;

  const limit = await checkGuestLimits({ ip: ["joinWaitlist"] });
  if (!limit.allowed) redirect(`${here}&error=rate_limited`);

  const result = await joinWaitlist({ host: await requestHost(), stay, roomTypeId, name, email, phone });
  if (!result.ok) redirect(`${here}&error=${result.error.code}`);
  redirect(`${here}&waitlisted=1`);
}
