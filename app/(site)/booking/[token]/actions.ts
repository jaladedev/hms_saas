"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { parseExperienceRequest } from "@/lib/guest-site/experiences";
import {
  createPaymentAttempt,
  paymentStartContext,
  requestExperience,
  requestOrigin,
  setGuestSmsOptOut,
  verifiedBookingId,
} from "@/lib/guest-site/server";
import { initializeTransaction } from "@/lib/paystack";
import { resolveProviderSecret } from "@/lib/provider-secret";

const inputSchema = z.object({ token: z.string().min(10).max(512), key: z.string().min(8).max(100) });

/**
 * Starts a Paystack checkout for the booking behind the token. The amount is decided by the database
 * (create_payment_attempt), never by the form. The key is per page render, so a refresh or back-button
 * resubmit reuses the same attempt and Paystack rejects the duplicate reference; the guest reloads the page for a new key.
 */
export async function payAction(formData: FormData): Promise<void> {
  const input = inputSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!input.success) redirect("/?error=bad_request");
  const { token, key } = input.data;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) redirect("/?error=bad_request");
  const back = `/booking/${token}`;

  const limit = await checkGuestLimits({ ip: ["pay"], keyed: [{ rule: "payReservation", value: reservationId }] });
  if (!limit.allowed) redirect(`${back}?error=rate_limited`);

  const context = await paymentStartContext(reservationId);
  if (!context.ok) redirect(`${back}?error=${context.error.code === "unknown" ? "payment_unavailable" : context.error.code}`);

  const attempt = await createPaymentAttempt(reservationId, `pay:${reservationId}:${key}`);
  if (!attempt.ok) redirect(`${back}?error=${attempt.error.code}`);

  let authorizationUrl: string;
  try {
    const secret = resolveProviderSecret(context.data.secret_reference);
    const origin = await requestOrigin();
    ({ authorizationUrl } = await initializeTransaction(
      {
        email: context.data.guest_email,
        amountMinor: attempt.data.amount_minor,
        currency: attempt.data.currency,
        reference: attempt.data.reference,
        callbackUrl: `${origin}${back}?paid=1`,
      },
      secret,
    ));
  } catch (error) {
    console.error("[pay] could not open checkout", { reservationId, message: error instanceof Error ? error.message : "unknown" });
    redirect(`${back}?error=payment_unavailable`);
  }
  redirect(authorizationUrl);
}

/**
 * Sends the hotel a request for an experience from the booking page. Nothing is held or paid: staff confirm the request and the hotel
 * adds it to the bill. The experience and the booking are checked again by the database.
 */
export async function experienceAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const input = z.object({ token: z.string().min(10).max(512) }).safeParse(raw);
  if (!input.success) redirect("/?error=bad_request");
  const { token } = input.data;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) redirect("/?error=bad_request");
  const back = `/booking/${token}`;

  const form = parseExperienceRequest(raw);
  if ("error" in form) redirect(`${back}?error=${form.error}#experiences`);

  const limit = await checkGuestLimits({ ip: ["pay"], keyed: [{ rule: "requestExperience", value: reservationId }] });
  if (!limit.allowed) redirect(`${back}?error=rate_limited#experiences`);

  const result = await requestExperience({ reservationId, ...form });
  if (!result.ok) redirect(`${back}?error=${result.error.code}#experiences`);
  redirect(`${back}?asked=1#experiences`);
}

/**
 * The guest stops text messages from the hotel, or allows them again, from their own booking page. The link proves who they are;
 * the database changes only this booking's guest and records that the guest did it.
 */
export async function smsOptOutAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const input = z.object({ token: z.string().min(10).max(512), optOut: z.enum(["0", "1"]) }).safeParse(raw);
  if (!input.success) redirect("/?error=bad_request");
  const { token, optOut } = input.data;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) redirect("/?error=bad_request");
  const back = `/booking/${token}`;
  const limit = await checkGuestLimits({ ip: ["pay"] });
  if (!limit.allowed) redirect(`${back}?error=rate_limited#texts`);
  const result = await setGuestSmsOptOut(reservationId, optOut === "1");
  if (!result.ok) redirect(`${back}?error=${result.error.code}#texts`);
  redirect(`${back}?texts=${optOut === "1" ? "off" : "on"}#texts`);
}
