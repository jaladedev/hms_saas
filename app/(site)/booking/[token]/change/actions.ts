"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { parseChangeRequest, parsePhone } from "@/lib/guest-site/change";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { changeDates, requestChange, updateContact, verifiedBookingId, withdrawChange } from "@/lib/guest-site/server";

const base = z.object({ token: z.string().min(10).max(512), key: z.string().min(8).max(100) });

/** The booking behind the token, the page to return to, and the per-booking rate check shared by the three actions. */
async function start(formData: FormData) {
  const input = base.safeParse(Object.fromEntries(formData.entries()));
  if (!input.success) redirect("/?error=bad_request");
  const reservationId = await verifiedBookingId(input.data.token);
  if (!reservationId) redirect("/?error=bad_request");
  const here = `/booking/${input.data.token}/change`;
  const limit = await checkGuestLimits({ ip: ["pay"], keyed: [{ rule: "changeBooking", value: reservationId }] });
  if (!limit.allowed) redirect(`${here}?error=rate_limited`);
  return { reservationId, here, key: input.data.key, token: input.data.token };
}

export async function updateContactAction(formData: FormData): Promise<void> {
  const { reservationId, here, key } = await start(formData);
  const phone = parsePhone(formData.get("phone"));
  if (!phone) redirect(`${here}?error=change_phone`);
  const result = await updateContact(reservationId, phone, `gcontact:${reservationId}:${key}`);
  if (!result.ok) redirect(`${here}?error=${result.error.code}`);
  redirect(`${here}?done=contact`);
}

export async function requestChangeAction(formData: FormData): Promise<void> {
  const { reservationId, here, key } = await start(formData);
  const parsed = parseChangeRequest(Object.fromEntries(formData.entries()));
  if (!parsed) redirect(`${here}?error=${formData.get("kind") === "dates" ? "change_dates" : "change_request"}`);
  const result = await requestChange({ reservationId, ...parsed, idempotencyKey: `greq:${reservationId}:${key}` });
  if (!result.ok) redirect(`${here}?error=${result.error.code}`);
  redirect(`${here}?done=request`);
}

export async function withdrawChangeAction(formData: FormData): Promise<void> {
  const { reservationId, here } = await start(formData);
  const result = await withdrawChange(reservationId);
  if (!result.ok) redirect(`${here}?error=${result.error.code}`);
  redirect(`${here}?done=withdrawn`);
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** Step 1 of changing dates: look at the price for the new dates (a plain GET back to the page, nothing changes). */
export async function checkDatesAction(formData: FormData): Promise<void> {
  const { here } = await start(formData);
  const arrival = String(formData.get("arrival") ?? "");
  const departure = String(formData.get("departure") ?? "");
  if (!isoDate.test(arrival) || !isoDate.test(departure)) redirect(`${here}?error=change_dates`);
  redirect(`${here}?arrival=${arrival}&departure=${departure}#dates`);
}

/** Step 2: confirm, with the total the guest was shown. The database checks every rule again and refuses if the price moved. */
export async function changeDatesAction(formData: FormData): Promise<void> {
  const { reservationId, here, key, token } = await start(formData);
  const arrival = String(formData.get("arrival") ?? "");
  const departure = String(formData.get("departure") ?? "");
  const total = Number(formData.get("expectedTotal"));
  if (!isoDate.test(arrival) || !isoDate.test(departure) || !Number.isSafeInteger(total) || total < 0)
    redirect(`${here}?error=change_dates`);
  const result = await changeDates({
    reservationId,
    arrival,
    departure,
    expectedTotalMinor: total,
    idempotencyKey: `gdates:${reservationId}:${key}`,
  });
  if (!result.ok) redirect(`${here}?error=${result.error.code}`);
  redirect(`/booking/${token}?done=dates_changed`);
}
