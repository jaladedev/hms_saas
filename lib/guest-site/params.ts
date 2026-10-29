import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "invalid date");
const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const stayParamsSchema = z
  .object({ arrival: isoDate, departure: isoDate, adults: intIn(1, 20).default(2), children: intIn(0, 20).default(0) })
  .refine((v) => v.departure > v.arrival, "departure must follow arrival");
export type StayParams = z.infer<typeof stayParamsSchema>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Parses Next.js searchParams into stay parameters, or null when absent or invalid. */
export function parseStayParams(raw: Record<string, string | string[] | undefined>): StayParams | null {
  const parsed = stayParamsSchema.safeParse({
    arrival: first(raw.arrival),
    departure: first(raw.departure),
    adults: first(raw.adults) ?? undefined,
    children: first(raw.children) ?? undefined,
  });
  return parsed.success ? parsed.data : null;
}

export const guestSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(32).optional().or(z.literal("")),
});

// guid(), not uuid(): accept any 8-4-4-4-12 hex id, exactly as Postgres does.
export const uuidSchema = z.guid();

export function stayQuery(p: StayParams): string {
  return new URLSearchParams({ arrival: p.arrival, departure: p.departure, adults: String(p.adults), children: String(p.children) }).toString();
}
