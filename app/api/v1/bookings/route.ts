import { apiErrorFor, apiJson, apiRoute } from "@/lib/api/v1";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/v1/bookings?arrival_from=&arrival_to=&status=&limit= (scope bookings.read; guest name and email only with guests.read). Up to 100, by arrival date. */
export async function GET(request: Request) {
  return apiRoute(request, "bookings.read", async (ctx, url) => {
    const from = url.searchParams.get("arrival_from") ?? "";
    const to = url.searchParams.get("arrival_to") ?? "";
    const limit = url.searchParams.get("limit");
    if (!DATE.test(from) || !DATE.test(to))
      return apiJson(400, { error: "invalid_request", message: "arrival_from and arrival_to are required as YYYY-MM-DD." });
    if (limit !== null && !/^\d{1,3}$/.test(limit))
      return apiJson(400, { error: "invalid_request", message: "limit must be a number from 1 to 100." });
    const { data, error } = await createServiceClient().rpc("api_bookings", {
      p_property: ctx.propertyId,
      p_from: from,
      p_to: to,
      p_status: url.searchParams.get("status") as string,
      p_limit: limit === null ? 50 : Number(limit),
      p_guest: ctx.scopes.includes("guests.read"),
    });
    if (error) return apiErrorFor(error.message);
    return apiJson(200, data);
  });
}
