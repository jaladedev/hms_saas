import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeskRow } from "./front-desk";

export type DeskReservation = DeskRow & { primary_guest_id: string };

const COLUMNS = "id, property_id, booking_reference, primary_guest_id, reservation_status, payment_status, arrival_date, departure_date, attention_reason";

/**
 * Everyone who is in house, or confirmed and could be arriving, late, or already here: the input to
 * `bucketFrontDesk`. `earliest` and `latest` are the earliest and latest "today" across the properties the
 * person can see; bucketing then judges each row against its own property's date. Used by the front desk
 * board and the overview, so both count the same people.
 */
export async function loadDeskRows(supabase: SupabaseClient, earliest: string, latest: string) {
  const { data, error } = await supabase
    .from("reservations").select(COLUMNS)
    .in("reservation_status", ["confirmed", "checked_in"])
    .lte("arrival_date", latest)
    // In-house guests are always wanted (an overdue one has a past departure); confirmed ones only if they have not already ended.
    .or(`reservation_status.eq.checked_in,departure_date.gte.${earliest}`)
    .order("booking_reference").limit(500);
  return { rows: (data ?? []) as DeskReservation[], error };
}
