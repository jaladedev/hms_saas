/** The wording for events results, kept apart from the form helpers so the shared notice can use it without importing them. */

export type EventErrorCode =
  | "ev_unavailable"
  | "ev_sold_out"
  | "ev_capacity"
  | "ev_no_lines"
  | "ev_deposit"
  | "ev_invalid"
  | "ev_past"
  | "ev_contact"
  | "ev_below_paid"
  | "ev_not_on_sale"
  | "ev_has_orders"
  | "ev_no_tickets"
  | "ev_too_many"
  | "ev_limit"
  | "ev_name_taken"
  | "ev_below_sold"
  | "ev_used"
  | "ev_too_early"
  | "ev_ticketed"
  | "ev_cancelled";

export const EVENT_ERROR_MESSAGES: Record<EventErrorCode, string> = {
  ev_unavailable: "That venue is already taken for part of that time. Nothing was changed. Choose another time or another venue.",
  ev_sold_out: "There are not enough tickets left of that type. Nothing was sold.",
  ev_capacity:
    "That is more people than the venue holds. Check the number of guests, or the ticket quantities against the venue's capacity.",
  ev_no_lines: "Add at least one line to the quote first.",
  ev_deposit: "The deposit has not been paid yet. Record the deposit first, or confirm with the deposit waived.",
  ev_invalid:
    "Some of the details are not valid. Check the dates and times (the end after the start), names, amounts and numbers, and try again.",
  ev_past: "That time has already passed. Choose a later one.",
  ev_contact: "Enter an email address or a phone number so the hotel can reach the client.",
  ev_below_paid: "The total cannot go below what has already been paid. Refund the difference first.",
  ev_not_on_sale: "Tickets are not on sale for that event.",
  ev_has_orders: "Tickets have been sold for this event, so that cannot be done. Cancel the event instead.",
  ev_no_tickets: "Add a ticket type that is switched on before putting the event on sale.",
  ev_too_many: "That is more tickets than one order may hold for this event.",
  ev_limit: "A limit was reached (venues, events, ticket types, room blocks or open requests). Remove one you no longer need first.",
  ev_name_taken: "Another ticket type for this event already has that name.",
  ev_below_sold: "That is fewer than the tickets already sold or held. Choose a higher number.",
  ev_used:
    "A ticket was already used at the door, or orders use this ticket type, so that cannot be changed. Switch the ticket type off instead.",
  ev_too_early: "The event has not started yet, so it cannot be marked as completed.",
  ev_ticketed: "A ticketed event's venue slot is managed from the event itself, not as a venue booking.",
  ev_cancelled: "That is cancelled and cannot be changed any more.",
};

export const EVENT_OK_MESSAGES = {
  ev_venue_saved: "Venue saved.",
  ev_settings_saved:
    "Event terms saved. They apply to enquiries and quotes made from now on; held and confirmed bookings keep the terms they were quoted on.",
  ev_booking_created: "Booking started. Add the quote lines, then hold the slot.",
  ev_booking_held:
    "Venue held. Take the deposit before the hold runs out and the booking is confirmed; if it runs out, the venue is released.",
  ev_booking_quoted: "Quote saved.",
  ev_booking_confirmed: "Booking confirmed. The venue is the client's for that time.",
  ev_booking_cancelled:
    "Booking cancelled. The venue and any room block are free again. Money already taken stays on the booking until it is refunded.",
  ev_booking_declined: "Enquiry declined.",
  ev_booking_completed: "Marked as completed.",
  ev_payment_recorded: "Payment recorded.",
  ev_refund_recorded: "Refund recorded.",
  ev_block_created: "Rooms held for the event's guests.",
  ev_block_released: "Room block released. The rooms can be booked again.",
  ev_link_saved: "Guest stay linked to the event.",
  ev_link_removed: "Guest stay unlinked.",
  ev_event_saved: "Event saved.",
  ev_event_on_sale: "Tickets are on sale. Guests see the event on your website.",
  ev_event_closed: "Sales closed. Tickets already sold still work at the door.",
  ev_event_draft: "Back to draft. Guests no longer see it.",
  ev_event_cancelled:
    "Event cancelled. Its venue is free again and its tickets are void. Money already taken stays on the orders until it is refunded.",
  ev_event_deleted: "Event deleted.",
  ev_type_saved: "Ticket type saved.",
  ev_type_deleted: "Ticket type deleted.",
  ev_sold: "Tickets sold. The buyer's codes are below.",
  ev_order_cancelled: "Order cancelled and its tickets voided. Money already taken stays on the order until it is refunded.",
} as const;
export type EventOkCode = keyof typeof EVENT_OK_MESSAGES;
