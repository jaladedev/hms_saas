import "server-only";
import type { VerifyResult } from "@/lib/paystack";
import { createServiceClient } from "@/lib/supabase/service";
import type { InvoicePaymentDeps } from "./invoice-payment";

/** The real dependencies for settling an invoice payment: the service-role database and Paystack's verify call. */
export function buildInvoicePaymentDeps(
  secret: string,
  verifyTransaction: (reference: string, secret: string) => Promise<VerifyResult>,
): InvoicePaymentDeps {
  const db = createServiceClient();
  return {
    secret,
    verifyTransaction,
    async settle(a) {
      const { data, error } = await db.rpc("settle_invoice_payment", {
        p_reference: a.reference,
        p_status: a.status,
        p_amount_minor: a.amountMinor,
        p_currency: a.currency,
      });
      if (error) throw new Error(error.message);
      return { result: (data as { result?: string } | null)?.result ?? "unknown" };
    },
    log(level, message, context) {
      console[level === "info" ? "log" : level](`[platform-invoice-payment] ${message}`, context ?? {});
    },
  };
}
