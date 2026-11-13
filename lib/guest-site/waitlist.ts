import { guestSchema, parseStayParams, uuidSchema, type StayParams } from "@/lib/guest-site/params";

export type WaitlistInput = { stay: StayParams; roomTypeId: string; name: string; email: string; phone: string };

/**
 * Reads the "tell me if a room frees up" form: the searched stay, the room type, and the guest's name, email and phone.
 * The phone is optional, digits with an optional + (spaces and dashes allowed), at most 32 characters. The email is lowercased.
 */
export function parseWaitlistForm(
  raw: Record<string, unknown>,
): { ok: true; value: WaitlistInput } | { ok: false; error: "bad_request" | "waitlist_details" } {
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const stay = parseStayParams({ arrival: str("arrival"), departure: str("departure"), adults: str("adults"), children: str("children") });
  const type = uuidSchema.safeParse(str("roomTypeId"));
  if (!stay || !type.success) return { ok: false, error: "bad_request" };
  const guest = guestSchema.pick({ full_name: true, email: true }).safeParse({ full_name: str("name"), email: str("email") });
  const phone = str("phone").trim();
  if (!guest.success || (phone && !/^\+?[0-9][0-9 \-()]{3,30}$/.test(phone))) return { ok: false, error: "waitlist_details" };
  return { ok: true, value: { stay, roomTypeId: type.data, name: guest.data.full_name, email: guest.data.email, phone } };
}
