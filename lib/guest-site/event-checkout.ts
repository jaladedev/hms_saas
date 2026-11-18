import "server-only";
import { redirect } from "next/navigation";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { createEventPaymentAttempt, eventPaymentContext, requestOrigin } from "@/lib/guest-site/server";
import { initializeTransaction } from "@/lib/paystack";
import { resolveProviderSecret } from "@/lib/provider-secret";

/**
 * Opens a Paystack checkout for a venue booking (the deposit, then the balance) or a ticket order (the whole total). The amount is decided by
 * the database (create_event_payment_attempt), never by the form. `back` is the guest's own page, where Paystack returns them.
 */
export async function startEventCheckout(kind: "booking" | "ticket_order", id: string, back: string, key: string): Promise<never> {
  const limit = await checkGuestLimits({ ip: ["pay"], keyed: [{ rule: "payEvent", value: id }] });
  if (!limit.allowed) redirect(`${back}?error=rate_limited`);

  const context = await eventPaymentContext(kind, id);
  if (!context.ok) redirect(`${back}?error=${context.error.code === "unknown" ? "payment_unavailable" : context.error.code}`);
  const attempt = await createEventPaymentAttempt(kind, id, `evpay:${id}:${key}`);
  if (!attempt.ok) redirect(`${back}?error=${attempt.error.code === "unknown" ? "payment_unavailable" : attempt.error.code}`);

  let authorizationUrl: string;
  try {
    const secret = resolveProviderSecret(context.data.secret_reference);
    const origin = await requestOrigin();
    ({ authorizationUrl } = await initializeTransaction(
      {
        email: context.data.payer_email,
        amountMinor: attempt.data.amount_minor,
        currency: attempt.data.currency,
        reference: attempt.data.reference,
        callbackUrl: `${origin}${back}?paid=1`,
      },
      secret,
    ));
  } catch (error) {
    console.error("[event pay] could not open checkout", { kind, id, message: error instanceof Error ? error.message : "unknown" });
    redirect(`${back}?error=payment_unavailable`);
  }
  redirect(authorizationUrl);
}
