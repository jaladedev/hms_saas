import { revalidatePath } from "next/cache";
import { parseChargeForm, parsePaymentForm } from "@/lib/staff/folio";
import { classifyFolioReplayError, folioReplayBodySchema, type ReplayResult } from "@/lib/offline/replay";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

/**
 * Sends folio changes made offline (a charge for extras, money taken for extras), in the order they were made. Each runs as the
 * signed-in person through `post_folio_charge` and `record_folio_payment`, the same functions as the buttons on the booking page,
 * so the database decides what is allowed: permissions, the booking being in house, the cap that a payment can never be more than
 * what is owed.
 *
 * The item's own id is the idempotency key (never a key from the page), so a request whose answer was lost can be sent again and
 * the change is recorded once. A form is read with the same parsers as the screen; one that does not parse is refused, not guessed.
 *
 * Dates: a charge keeps the day the person chose on the form (the database refuses a day in the future or before arrival). A
 * payment is sent with the time it was really taken (`p_at`, migration 192) and the database decides what to do with it: it is kept
 * inside bounds it trusts (never in the future, at most two days back, never before the booking), a closed day is never added to,
 * and the note says when the money was taken. The note is the person's own words here; the time is not part of the idempotency hash.
 */
export async function POST(request: Request) {
  // A cross-site form cannot send JSON, and the session cookie is not sent cross-site anyway.
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return Response.json({ error: "bad_request" }, { status: 415, headers });
  }
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: "signed_out" }, { status: 401, headers });

  const parsed = folioReplayBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400, headers });

  const results: ReplayResult[] = [];
  const touched = new Set<string>();
  for (const item of parsed.data.items) {
    if (item.userId !== auth.user.id) {
      results.push({ id: item.id, status: "rejected", reason: "other_user" });
      continue;
    }

    let error: { message: string } | null;
    if (item.action === "folio_charge") {
      const v = parseChargeForm(item.fields);
      if (!v.ok) {
        results.push({ id: item.id, status: "rejected", reason: "invalid" });
        continue;
      }
      const c = v.value;
      ({ error } = await supabase.rpc("post_folio_charge", {
        p_reservation_id: item.reservationId,
        p_category: c.category,
        p_description: c.description,
        p_quantity: c.quantity,
        p_unit_amount_minor: c.unitAmountMinor,
        p_idempotency_key: item.id,
        p_charge_date: c.date,
        p_reservation_room_id: c.roomId,
      }));
    } else {
      const v = parsePaymentForm(item.fields);
      if (!v.ok) {
        results.push({ id: item.id, status: "rejected", reason: "invalid" });
        continue;
      }
      const p = v.value;
      ({ error } = await supabase.rpc("record_folio_payment", {
        p_reservation_id: item.reservationId,
        p_amount_minor: p.amountMinor,
        p_method: p.method,
        p_reference: p.reference,
        p_note: p.note,
        p_at: item.madeAt,
        p_idempotency_key: item.id,
      }));
    }

    if (error) results.push({ id: item.id, ...classifyFolioReplayError(error.message) });
    else {
      results.push({ id: item.id, status: "done" });
      touched.add(item.reservationId);
    }
  }

  for (const id of touched) revalidatePath(`/app/reservations/${id}`);
  return Response.json({ results }, { headers });
}
