import { NextResponse } from "next/server";
import { hoursCsv, hoursFileName, parseHoursReport } from "@/lib/staff/hr";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const plain = (status: number, text: string) =>
  new NextResponse(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The hours report as a CSV file. Needs a signed-in user with hr.manage (the database checks it again). Hours and leave days only, no pay. */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return plain(401, "Sign in first.");
  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!UUID.test(propertyId) || !DATE.test(from) || !DATE.test(to)) return plain(400, "Choose a hotel and dates.");
  const [propQ, repQ] = await Promise.all([
    supabase.from("properties").select("name").eq("id", propertyId).maybeSingle(),
    supabase.rpc("hr_hours_report", { p_property: propertyId, p_from: from, p_to: to }),
  ]);
  const report = parseHoursReport(repQ.data);
  if (repQ.error || !report || !propQ.data) return plain(404, "Not found.");
  return new NextResponse("﻿" + hoursCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${hoursFileName(propQ.data.name, from, to)}"`,
      "cache-control": "no-store",
    },
  });
}
