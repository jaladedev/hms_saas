import { isAuthorizedCron } from "@/lib/maintenance";
import { evaluateHealth, httpStatusFor, type RawHealth } from "@/lib/ops-health";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For an uptime monitor: `Authorization: Bearer $CRON_SECRET`. 200 for ok or warn, 503 for fail (money or booking trouble, or the
 * maintenance job has stopped) or when the database cannot be read. The body lists what is wrong; it holds counts, never guest data.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data, error } = await createServiceClient().rpc("ops_health");
  if (error || !data) {
    return Response.json(
      { status: "fail", issues: [{ check: "database", level: "fail", detail: "health check could not read the database" }] },
      { status: 503 },
    );
  }
  const report = evaluateHealth(data as unknown as RawHealth);
  return Response.json(report, { status: httpStatusFor(report.status), headers: { "cache-control": "no-store" } });
}
