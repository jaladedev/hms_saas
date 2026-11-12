"use server";

import { redirect } from "next/navigation";
import { requestOrigin } from "@/lib/guest-site/server";
import { initializeTransaction } from "@/lib/paystack";
import { platformPaystackSecret } from "@/lib/platform/invoice-payment";
import { back, staffClient } from "./action-helpers";

const PAGE = "/app/settings/billing";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Starts a card payment for one of the hotel's open platform invoices (migration 117). Runs as the signed-in person: the database
 * function needs property.configure at that hotel and takes the amount and currency from the invoice itself. The person is sent to
 * Paystack's page and comes back to /app/settings/billing/return, which verifies the payment before the invoice is marked paid.
 */
export async function payInvoiceOnline(formData: FormData) {
  const propertyId = String(formData.get("propertyId") ?? "");
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!UUID.test(propertyId) || !UUID.test(invoiceId)) return back(PAGE, { err: "invoice_pay_failed" });
  const secret = platformPaystackSecret();
  if (!secret) return back(PAGE, { err: "invoice_pay_unavailable" });

  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("hotel_start_invoice_payment", { p_property: propertyId, p_invoice: invoiceId });
  if (error) {
    if (/NOT_FOUND/.test(error.message)) return back(PAGE, { err: "setup_forbidden" });
    if (/CONFLICT: invoice state/.test(error.message)) return back(PAGE, { err: "invoice_pay_closed" });
    return back(PAGE, { err: "invoice_pay_failed" });
  }
  const s = data as { reference?: string; amount_minor?: number; currency?: string; email?: string } | null;
  if (!s?.reference || !s.email || typeof s.amount_minor !== "number" || !s.currency) return back(PAGE, { err: "invoice_pay_failed" });

  let url: string;
  try {
    const origin = await requestOrigin();
    ({ authorizationUrl: url } = await initializeTransaction(
      { email: s.email, amountMinor: s.amount_minor, currency: s.currency, reference: s.reference, callbackUrl: `${origin}${PAGE}/return` },
      secret,
    ));
  } catch (e) {
    console.error("[invoice-pay] could not open checkout", { invoiceId, message: e instanceof Error ? e.message : "unknown" });
    return back(PAGE, { err: "invoice_pay_failed" });
  }
  redirect(url);
}
