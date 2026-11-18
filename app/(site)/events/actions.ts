"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createEventToken } from "@/lib/event-token";
import { serverEnv } from "@/lib/env";
import { parseTicketOrder } from "@/lib/guest-site/events";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { createTicketOrder, requestHost } from "@/lib/guest-site/server";

const keySchema = z.string().min(8).max(100);
const HALF_YEAR = 180 * 24 * 3600;

/** Holds the tickets for 20 minutes and sends the buyer to their order page, where they pay. The link on that page is also where the tickets show. */
export async function ticketOrderAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const key = keySchema.safeParse(raw.key);
  const form = parseTicketOrder(raw);
  if (!form.ok || !key.success) redirect("/events?error=bad_request");
  const v = form.value;
  const limit = await checkGuestLimits({ ip: ["orderTickets"], keyed: [{ rule: "holdEmail", value: v.email.toLowerCase() }] });
  if (!limit.allowed) redirect("/events?error=rate_limited");

  const result = await createTicketOrder({ host: await requestHost(), ...v, key: key.data });
  if (!result.ok) redirect(`/events?error=${result.error.code}`);
  const token = createEventToken("t", result.data.order_id, serverEnv().BOOKING_TOKEN_SECRET, HALF_YEAR);
  redirect(`/tickets/${token}`);
}
