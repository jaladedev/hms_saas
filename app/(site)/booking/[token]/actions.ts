"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { createPaymentAttempt, paymentStartContext, requestOrigin } from "@/lib/guest-site/server";
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
  const reservationId = verifyBookingToken(token, serverEnv().BOOKING_TOKEN_SECRET);
  if (!reservationId) redirect("/?error=bad_request");
  const back = `/booking/${token}`;

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
