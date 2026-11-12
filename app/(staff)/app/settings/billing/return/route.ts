import { NextResponse } from "next/server";
import { verifyTransaction } from "@/lib/paystack";
import { platformPaystackSecret, settleInvoiceReference, type SettleResult } from "@/lib/platform/invoice-payment";
import { buildInvoicePaymentDeps } from "@/lib/platform/invoice-payment-server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE = "/app/settings/billing";

/**
 * Where Paystack sends the person back after paying an invoice. It verifies the reference with Paystack and settles it (the webhook
 * does the same, and the database settles an attempt once), then shows the result on the billing page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const go = (qs: string) => NextResponse.redirect(new URL(`${PAGE}?${qs}`, url));
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", url));
  const reference = url.searchParams.get("reference") ?? url.searchParams.get("trxref") ?? "";
  const secret = platformPaystackSecret();
  if (!secret) return go("err=invoice_pay_unavailable");
  let result: SettleResult;
  try {
    result = await settleInvoiceReference(buildInvoicePaymentDeps(secret, verifyTransaction), reference);
  } catch {
    return go("ok=invoice_pay_pending");
  }
  if (result === "paid" || result === "duplicate") return go("ok=invoice_paid");
  if (result === "not_success") return go("ok=invoice_pay_pending");
  if (result === "mismatch" || result === "invoice_closed") return go("err=invoice_pay_review");
  return go("err=invoice_pay_failed");
}
