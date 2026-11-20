import { apiErrorFor, apiJson, apiRoute } from "@/lib/api/v1";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/bookings/BK-XXXXXXXX (scope bookings.read; guest name and email only with guests.read). */
export async function GET(request: Request, context: { params: Promise<{ reference: string }> }) {
  const { reference } = await context.params;
  return apiRoute(request, "bookings.read", async (ctx) => {
    if (!/^[A-Za-z0-9-]{3,40}$/.test(reference)) return apiJson(404, { error: "not_found" });
    const { data, error } = await createServiceClient().rpc("api_booking", {
      p_property: ctx.propertyId,
      p_reference: reference,
      p_guest: ctx.scopes.includes("guests.read"),
    });
    if (error) return apiErrorFor(error.message);
    return apiJson(200, data);
  });
}
