import {
  detectUnit,
  MAX_FILE_BYTES,
  MAX_ROWS,
  readProviderRows,
  reconcile,
  type AmountUnit,
  type OurPayment,
} from "@/lib/staff/reconciliation";
import { MAX_RANGE_DAYS, parseRange } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const PAGE = 1000;

/**
 * Compares an uploaded Paystack transactions CSV with the Paystack payments recorded for one property over the days
 * the file covers. It only reads, and it runs as the signed-in person: payment.verify is needed, and the payments are
 * read through row level security, so a role that cannot see money cannot run it (checked here too, because a hidden
 * payment would otherwise show up as "missing here").
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return json({ error: "Sign in first." }, 401);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Send the file as a form upload." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return json({ error: "Choose the CSV file Paystack gave you." }, 400);
  if (file.size > MAX_FILE_BYTES)
    return json({ error: `That file is larger than ${MAX_FILE_BYTES / 1_000_000} MB. Export a shorter period.` }, 400);

  const propertyId = String(form.get("property") ?? "");
  const { data: prop } = await supabase.from("properties").select("id, timezone").eq("id", propertyId).maybeSingle();
  if (!prop) return json({ error: "Not found." }, 404);
  const [verify, money] = await Promise.all([
    supabase.rpc("has_permission", { p_property: prop.id, p_permission: "payment.verify" }),
    supabase.rpc("can_view_money", { p_property: prop.id }),
  ]);
  if (verify.data !== true || money.data !== true) return json({ error: "Not found." }, 404);

  // The two ends must be given and must be exactly the days asked for: a silently adjusted range would compare the wrong days.
  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  const range = parseRange(from, to, todayIn(prop.timezone, new Date()));
  if (range.from !== from || range.to !== to || range.trimmed) {
    return json({ error: `Choose the first and last day the export covers, ${MAX_RANGE_DAYS} days at most.` }, 400);
  }

  const read = readProviderRows(await file.text());
  if (read.fatal) return json({ error: read.problems[0], problems: read.problems }, 400);

  // Payments are stored with a timestamp, the file speaks in days. Read a day either side, then keep the property's own days.
  const lower = new Date(`${range.from}T00:00:00Z`);
  lower.setUTCDate(lower.getUTCDate() - 1);
  const upper = new Date(`${range.to}T00:00:00Z`);
  upper.setUTCDate(upper.getUTCDate() + 2);
  const ours: OurPayment[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await supabase
      .from("payments")
      .select("id, reservation_id, provider_reference, amount_minor, currency, payment_status, received_at")
      .eq("property_id", prop.id)
      .eq("payment_provider", "paystack")
      .gte("received_at", lower.toISOString())
      .lt("received_at", upper.toISOString())
      .order("id")
      .range(start, start + PAGE - 1);
    if (error) return json({ error: "Could not read the payments. Try again in a moment." }, 500);
    for (const p of data ?? []) {
      if (!p.provider_reference) continue;
      const day = todayIn(prop.timezone, new Date(p.received_at));
      if (day < range.from || day > range.to) continue;
      ours.push({
        id: p.id,
        reservation_id: p.reservation_id,
        reference: p.provider_reference,
        amount_minor: Number(p.amount_minor),
        currency: p.currency,
        payment_status: p.payment_status === "reversed" ? "reversed" : "succeeded",
      });
    }
    if ((data ?? []).length < PAGE) break;
    if (start + PAGE >= MAX_ROWS) return json({ error: "Too many payments in that period to compare. Choose fewer days." }, 400);
  }

  const asked = String(form.get("unit") ?? "auto");
  let unit: AmountUnit;
  let unitSource: "chosen" | "detected";
  if (asked === "naira" || asked === "kobo") {
    unit = asked;
    unitSource = "chosen";
  } else {
    const found = detectUnit(read.rows, ours);
    if (!found.unit) {
      return json(
        {
          error:
            "Could not tell whether the amounts in the file are in naira or kobo, because no successful payment in it matches one recorded here. Choose the unit and run it again.",
        },
        422,
      );
    }
    unit = found.unit;
    unitSource = "detected";
  }

  return json({
    range: { from: range.from, to: range.to },
    unit,
    unitSource,
    columns: read.columns,
    problems: read.problems,
    recordedHere: ours.length,
    result: reconcile(read.rows, ours, unit),
  });
}
