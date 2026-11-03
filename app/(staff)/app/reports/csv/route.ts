import { NextResponse } from "next/server";
import { parseRange } from "@/lib/staff/reports";
import { csvFileName, reportCsv } from "@/lib/staff/reports-csv";
import { todayIn } from "@/lib/staff/reservations";
import type { Report } from "@/lib/staff/reports";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (status: number, text: string) => new NextResponse(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The daily report as a CSV file. Needs a signed-in user with report.export; the database checks report.view again. */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return plain(401, "Sign in first.");

  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property") ?? "";
  if (!UUID.test(propertyId)) return plain(400, "Choose a property.");

  const [exportOk, propQ] = await Promise.all([
    supabase.rpc("has_permission", { p_property: propertyId, p_permission: "report.export" }),
    supabase.from("properties").select("name, timezone").eq("id", propertyId).maybeSingle(),
  ]);
  if (exportOk.data !== true || !propQ.data) return plain(404, "Not found.");

  const today = todayIn(propQ.data.timezone, new Date());
  const range = parseRange({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined }, today);
  const { data, error } = await supabase.rpc("daily_report", { p_property_id: propertyId, p_from: range.from, p_to: range.to });
  if (error || !data) return plain(404, "Not found.");

  return new NextResponse("﻿" + reportCsv(data as Report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName(propQ.data.name, range.from, range.to)}"`,
      "cache-control": "no-store",
    },
  });
}
