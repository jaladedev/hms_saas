import { parseRange, toCsv, type ReportDay } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** The daily report as a CSV file. It runs as the signed-in person: needs report.export here, and `daily_report` checks report.view again. */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new Response("Sign in first.", { status: 401 });

  const q = new URL(request.url).searchParams;
  const propertyId = q.get("property") ?? "";
  const { data: prop } = await supabase.from("properties").select("id, timezone").eq("id", propertyId).maybeSingle();
  if (!prop) return new Response("Not found.", { status: 404 });

  // Downloading needs report.export on top of report.view (the occupancy download works the same way).
  const { data: mayExport } = await supabase.rpc("has_permission", { p_property: prop.id, p_permission: "report.export" });
  if (mayExport !== true) return new Response("Not found.", { status: 404 });

  const range = parseRange(q.get("from"), q.get("to"), todayIn(prop.timezone, new Date()));
  const { data, error } = await supabase.rpc("daily_report", { p_property: prop.id, p_from: range.from, p_to: range.to });
  if (error) return new Response("Not found.", { status: 404 });

  return new Response(toCsv((data ?? []) as ReportDay[]), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="report-${range.from}-to-${range.to}.csv"`,
      "cache-control": "no-store",
    },
  });
}
