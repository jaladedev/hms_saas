/** The no-show list under the channel report (migration 046). Pure, so it can be tested. */
import { sourceLabel } from "./channels";
import { csvField, major } from "./reports-csv";

export type NoShowRow = {
  /** Null unless the viewer holds reservation.view. */
  reservation_id: string | null;
  booking_reference: string | null;
  arrival_date: string;
  nights: number;
  source: string;
  /** Null unless the viewer holds guest.view. */
  guest_name: string | null;
  charge_minor: number;
};
export type NoShowList = {
  property_id: string;
  currency: string;
  from: string;
  to: string;
  /** All no-shows in the range; `rows` holds at most the newest 200. */
  total: number;
  rows: NoShowRow[];
  names_hidden: boolean;
  links_hidden: boolean;
};

/** Money charged for a no-show, or a dash when nothing was charged (a waived or free no-show). */
export const chargeLabel = (minor: number, format: (n: number) => string): string => (minor > 0 ? format(minor) : "–");

/** Sum of the charges on the rows shown. Not the whole range when the list is cut (see `total`). */
export const chargedMinor = (rows: NoShowRow[]): number => rows.reduce((n, r) => n + r.charge_minor, 0);

export const isCut = (l: Pick<NoShowList, "total" | "rows">): boolean => l.total > l.rows.length;

/** CSV: the booking and guest columns are left out for people who may not see them. Money in naira. */
export function noShowsCsv(l: NoShowList): string {
  const header = ["Arrival", "Nights", "Source", ...(l.links_hidden ? [] : ["Booking"]), ...(l.names_hidden ? [] : ["Guest"]), "Charge"];
  const rows = l.rows.map((r) => [
    r.arrival_date,
    r.nights,
    sourceLabel(r.source),
    ...(l.links_hidden ? [] : [r.booking_reference ?? ""]),
    ...(l.names_hidden ? [] : [r.guest_name ?? ""]),
    major(r.charge_minor),
  ]);
  return [header, ...rows].map((row) => row.map((v) => csvField(v)).join(",")).join("\r\n") + "\r\n";
}
