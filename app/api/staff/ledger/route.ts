import { LEDGER_PAGE, MAX_LEDGER_ROWS, ledgerCsv, ledgerFileName, type LedgerRow } from "@/lib/staff/ledger-csv";
import { parseRange } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * Every payment and refund of a period as a CSV file, for the accountant (`money_ledger`, migration 193). It runs as the signed-in
 * person: report.export is needed here (the same right as the report download) and the database checks it again. The period is the
 * report's own (at most 92 days).
 *
 * The API returns at most 1000 rows to one call, so the ledger is read in pages, in the order the database gives it. If the period
 * holds more rows than a file may (MAX_LEDGER_ROWS) nothing is sent but a message asking for fewer days: a file that stops short
 * without saying so would be worse than no file.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return text("Sign in first.", 401);

  const q = new URL(request.url).searchParams;
  const { data: prop } = await supabase
    .from("properties")
    .select("id, name, timezone")
    .eq("id", q.get("property") ?? "")
    .maybeSingle();
  if (!prop) return text("Not found.", 404);

  const { data: mayExport } = await supabase.rpc("has_permission", { p_property: prop.id, p_permission: "report.export" });
  if (mayExport !== true) return text("Not found.", 404);

  const range = parseRange(q.get("from"), q.get("to"), todayIn(prop.timezone, new Date()));
  const rows: LedgerRow[] = [];
  for (let start = 0; ; start += LEDGER_PAGE) {
    const { data, error } = await supabase
      .rpc("money_ledger", { p_property: prop.id, p_from: range.from, p_to: range.to })
      .range(start, start + LEDGER_PAGE - 1);
    if (error) {
      if (/NOT_FOUND/.test(error.message)) return text("Not found.", 404);
      return text("Could not read the payments. Try again in a moment.", 500);
    }
    const page = (data ?? []) as LedgerRow[];
    rows.push(...page);
    if (page.length < LEDGER_PAGE) break;
    if (rows.length >= MAX_LEDGER_ROWS) {
      return text("There are too many payments in that period for one file. Choose fewer days.", 400);
    }
  }

  return new Response(ledgerCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${ledgerFileName(prop.name, range.from, range.to)}"`,
      "cache-control": "no-store",
    },
  });
}
