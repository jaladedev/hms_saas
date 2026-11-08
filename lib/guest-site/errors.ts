/** Maps database and provider errors to messages a guest can act on. Unknown errors get a generic one. */
export type GuestError = { code: string; message: string };

const RULES: Array<[RegExp, GuestError]> = [
  [/ROOM_UNAVAILABLE/, { code: "unavailable", message: "Sorry, those rooms were just taken. Please choose different dates or a different room." }],
  [/CAPACITY_EXCEEDED/, { code: "capacity", message: "That room type cannot take this many guests." }],
  [/too many active holds/i, { code: "too_many_holds", message: "You already have several unpaid reservations. Please pay for or wait out an existing one first." }],
  [/POLICY_VIOLATION: guest/, { code: "guest_details", message: "Please check your name and email address." }],
  [/POLICY_VIOLATION: (stay too long|arrival too far ahead|arrival in the past|departure must follow arrival)/, { code: "dates", message: "Please check your dates." }],
  [/hold lapsed|INVALID_STATE: (pending|expired)/, { code: "hold_lapsed", message: "Your reservation hold has expired. Please search again to make a new reservation." }],
  [/POLICY_VIOLATION: charge changed/, { code: "charge_changed", message: "The cancellation charge changed while you were reading. Please check the new amount below and confirm again." }],
  [/INVALID_STATE: disabled/, { code: "cancel_disabled", message: "This hotel does not take cancellations online. Please contact the hotel." }],
  [/INVALID_STATE: too late/, { code: "cancel_too_late", message: "It is too late to cancel online. Please contact the hotel." }],
  [/INVALID_STATE: (cancelled|checked_in|checked_out|no_show)/, { code: "cancel_not_allowed", message: "This booking can no longer be cancelled online. Please contact the hotel." }],
  [/INVALID_STATE: nothing due/, { code: "nothing_due", message: "Nothing is left to pay on this booking." }],
  [/INVALID_STATE: online booking off/, { code: "booking_off", message: "This hotel is not taking online bookings right now. Please contact the hotel." }],
  [/INVALID_STATE: dates /, { code: "dates_not_self_serve", message: "These dates cannot be changed online. You can send the hotel a request instead." }],
  [/POLICY_VIOLATION: total changed/, { code: "dates_total_changed", message: "The price changed while you were deciding. Please check the new dates again." }],
  [/RATE_MISSING/, { code: "dates_no_rate", message: "Those dates cannot be booked online yet. Please send the hotel a request." }],
  [/INVALID_STATE: change disabled/, { code: "change_disabled", message: "This hotel does not take booking changes online. Please contact the hotel." }],
  [/INVALID_STATE: change (status|started)/, { code: "change_not_allowed", message: "This booking can no longer be changed online. Please contact the hotel." }],
  [/INVALID_STATE: change window/, { code: "change_window", message: "It is too close to your arrival to ask for this online. Please contact the hotel." }],
  [/INVALID_STATE: change open request/, { code: "change_open", message: "You already have a request waiting for the hotel. Withdraw it first if you want to send a different one." }],
  [/POLICY_VIOLATION: phone/, { code: "change_phone", message: "Please enter a phone number with digits only, and an optional + at the start." }],
  [/POLICY_VIOLATION: dates/, { code: "change_dates", message: "Please check the new dates: they must be in the future, at most 30 nights, and different from your booking." }],
  [/POLICY_VIOLATION: request/, { code: "change_request", message: "Please add a short message so the hotel knows what you need." }],
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
