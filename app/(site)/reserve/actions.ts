"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { createBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { guestSchema, parseStayParams, stayQuery, uuidSchema } from "@/lib/guest-site/params";
import { drainNow } from "@/lib/email/server";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { createHold, requestHost } from "@/lib/guest-site/server";

const BOOKING_LINK_TTL_SECONDS = 3 * 24 * 60 * 60;
const inputSchema = z.object({
  type: uuidSchema,
  quantity: z.coerce.number().int().min(1).max(5),
  key: z.string().min(8).max(100),
});

export async function reserveAction(formData: FormData): Promise<void> {
  const fields = Object.fromEntries(formData.entries());
  const stay = parseStayParams(fields as Record<string, string>);
  if (!stay) redirect("/?error=bad_request");
  const base = `/reserve?${stayQuery(stay)}&type=${encodeURIComponent(String(fields.type ?? ""))}`;

  const input = inputSchema.safeParse(fields);
  const guest = guestSchema.safeParse(fields);
  if (!input.success || !guest.success) redirect(`${base}&error=bad_request`);

  const limit = await checkGuestLimits({ ip: ["hold"], keyed: [{ rule: "holdEmail", value: guest.data.email }] });
  if (!limit.allowed) redirect(`${base}&error=rate_limited`);

  const result = await createHold({
    host: await requestHost(),
    stay,
    roomTypeId: input.data.type,
    quantity: input.data.quantity,
    guest: { full_name: guest.data.full_name, email: guest.data.email, ...(guest.data.phone ? { phone: guest.data.phone } : {}) },
    idempotencyKey: input.data.key,
  });
  if (!result.ok) redirect(`${base}&error=${result.error.code}`);

  after(() => { drainNow(5).catch(() => {}); });   // quick send; the maintenance route is the backstop
  const token = createBookingToken(result.data.reservation_id, serverEnv().BOOKING_TOKEN_SECRET, BOOKING_LINK_TTL_SECONDS);
  redirect(`/booking/${token}`);
}
