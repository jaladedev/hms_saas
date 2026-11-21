import { z } from "zod";
import { guestSchema, stayParamsSchema, uuidSchema } from "@/lib/guest-site/params";

/** The body of POST /api/v1/bookings. Unknown fields are refused so a typo is not silently ignored. */
export const createBookingSchema = z
  .object({
    arrival: z.string(),
    departure: z.string(),
    adults: z.number().int().min(1).max(20).default(2),
    children: z.number().int().min(0).max(20).default(0),
    room_type_id: uuidSchema,
    quantity: z.number().int().min(1).max(5).default(1),
    guest: guestSchema.omit({ promo_code: true }).strict(),
    promo_code: z.string().trim().max(24).optional(),
  })
  .strict();
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export type ParsedBooking =
  | { ok: true; value: CreateBookingInput & { stay: z.infer<typeof stayParamsSchema> } }
  | { ok: false; message: string };

export function parseCreateBooking(raw: unknown): ParsedBooking {
  const body = createBookingSchema.safeParse(raw);
  if (!body.success) {
    const first = body.error.issues[0];
    return { ok: false, message: first ? `${first.path.join(".") || "body"}: ${first.message}` : "invalid body" };
  }
  const stay = stayParamsSchema.safeParse({
    arrival: body.data.arrival,
    departure: body.data.departure,
    adults: body.data.adults,
    children: body.data.children,
  });
  if (!stay.success) return { ok: false, message: stay.error.issues[0]?.message ?? "invalid dates" };
  return { ok: true, value: { ...body.data, stay: stay.data } };
}

/** The Idempotency-Key header: 8 to 100 characters of letters, digits, dash, underscore, dot or colon. */
export function parseIdempotencyKey(header: string | null): string | null {
  const v = header?.trim() ?? "";
  return /^[A-Za-z0-9_.:-]{8,100}$/.test(v) ? v : null;
}
