/** Maps database and provider errors to messages a guest can act on. Unknown errors get a generic one. */
export type GuestError = { code: string; message: string };

const RULES: Array<[RegExp, GuestError]> = [
  [/ROOM_UNAVAILABLE/, { code: "unavailable", message: "Sorry, those rooms were just taken. Please choose different dates or a different room." }],
  [/CAPACITY_EXCEEDED/, { code: "capacity", message: "That room type cannot take this many guests." }],
  [/too many active holds/i, { code: "too_many_holds", message: "You already have several unpaid reservations. Please pay for or wait out an existing one first." }],
  [/POLICY_VIOLATION: guest/, { code: "guest_details", message: "Please check your name and email address." }],
  [/POLICY_VIOLATION: (stay too long|arrival too far ahead|arrival in the past|departure must follow arrival)/, { code: "dates", message: "Please check your dates." }],
  [/hold lapsed|INVALID_STATE: (pending|expired)/, { code: "hold_lapsed", message: "Your reservation hold has expired. Please search again to make a new reservation." }],
  [/INVALID_STATE: nothing due/, { code: "nothing_due", message: "Nothing is left to pay on this booking." }],
  [/NOT_FOUND: (host|property)/, { code: "not_configured", message: "Online booking is not available on this site yet." }],
  [/NOT_FOUND: room type/, { code: "not_bookable", message: "That room type is not available to book online." }],
];

export function friendlyError(message: string | undefined | null): GuestError {
  const text = message ?? "";
  for (const [pattern, error] of RULES) if (pattern.test(text)) return error;
  return { code: "unknown", message: "Something went wrong on our side. Please try again in a moment." };
}

const BY_CODE = new Map(RULES.map(([, e]) => [e.code, e]));
BY_CODE.set("unknown", { code: "unknown", message: "Something went wrong on our side. Please try again in a moment." });
BY_CODE.set("payment_unavailable", { code: "payment_unavailable", message: "We could not open the payment page. Please try again." });
BY_CODE.set("rate_limited", { code: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." });
BY_CODE.set("bad_request", { code: "bad_request", message: "Please check the details you entered." });

/** Looks up a message for a code carried in a redirect URL. Unknown codes are not echoed back. */
export function messageForCode(code: string | undefined): string | null {
  if (!code) return null;
  return BY_CODE.get(code)?.message ?? null;
}
