import { apiErrorFor, apiJson, apiRoute } from "@/lib/api/v1";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = (v: string | null, fallback: number) => (v !== null && /^\d{1,2}$/.test(v) ? Number(v) : fallback);

/** GET /api/v1/availability?arrival=2026-12-01&departure=2026-12-03&adults=2&children=0 (scope availability.read). Same answer as the booking website. */
export async function GET(request: Request) {
  return apiRoute(request, "availability.read", async (ctx, url) => {
    const arrival = url.searchParams.get("arrival") ?? "";
    const departure = url.searchParams.get("departure") ?? "";
    if (!DATE.test(arrival) || !DATE.test(departure))
      return apiJson(400, { error: "invalid_request", message: "arrival and departure are required as YYYY-MM-DD." });
    const { data, error } = await createServiceClient().rpc("api_availability", {
      p_property: ctx.propertyId,
      p_arrival: arrival,
      p_departure: departure,
      p_adults: int(url.searchParams.get("adults"), 1),
      p_children: int(url.searchParams.get("children"), 0),
    });
    if (error) return apiErrorFor(error.message);
    return apiJson(200, data);
  });
}
