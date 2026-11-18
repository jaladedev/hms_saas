"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { drainEventEmailsNow } from "@/lib/email/server";
import { z } from "zod";
import { createEventToken } from "@/lib/event-token";
import { serverEnv } from "@/lib/env";
import { parseVenueRequest } from "@/lib/guest-site/events";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { requestHost, requestVenue } from "@/lib/guest-site/server";

const keySchema = z.string().min(8).max(100);
const SIXTY_DAYS = 60 * 24 * 3600;

/**
 * An enquiry (nothing held) or an online booking (held for the hotel's hold hours at the venue's hire price, deposit paid next). Either way the guest
 * lands on their own page behind a signed link. The database decides availability, lead time, capacity and the price.
 */
export async function venueRequestAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const key = keySchema.safeParse(raw.key);
  const form = parseVenueRequest(raw);
  if (!form.ok || !key.success) redirect("/venues?error=bad_request");
  const v = form.value;
  const limit = await checkGuestLimits({ ip: ["requestVenue"], keyed: [{ rule: "holdEmail", value: v.email.toLowerCase() }] });
  if (!limit.allowed) redirect("/venues?error=rate_limited");

  const result = await requestVenue({ host: await requestHost(), ...v, key: key.data });
  if (!result.ok) redirect(`/venues?error=${result.error.code}`);
  after(() => {
    drainEventEmailsNow(5).catch(() => {});
  });
  const token = createEventToken("v", result.data.booking_id, serverEnv().BOOKING_TOKEN_SECRET, SIXTY_DAYS);
  redirect(`/event-booking/${token}${v.mode === "enquiry" ? "?sent=1" : ""}`);
}
