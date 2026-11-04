/** What the overview page adds up. Pure functions, so the counting rules are tested without a database. */

import type { DeskGroups } from "./front-desk";
import { countRequests, type RequestBrief } from "./maintenance";
import { STUCK_AFTER_MINUTES, minutesSince } from "./refunds";

export type { RequestBrief };

/** Only the refund columns the overview reads. */
export type RefundBrief = {
  refund_status: string;
  requested_by: string | null;
  attention_note: string | null;
  provider_call_started_at: string | null;
};

export type RefundCounts = {
  /** A payout whose result is unknown or overdue. */
  stuck: number;
  /** Requested by someone else, so this person could approve it. */
  toApprove: number;
  /** Requested by this person: waiting on a second person, nothing for them to do. */
  waitingOnOthers: number;
  /** Approved and ready to pay out. */
  toPay: number;
};

export function countRefunds(rows: RefundBrief[], viewerId: string | null, now: Date): RefundCounts {
  const c: RefundCounts = { stuck: 0, toApprove: 0, waitingOnOthers: 0, toPay: 0 };
  for (const r of rows) {
    if (r.refund_status === "processing") {
      const mins = minutesSince(r.provider_call_started_at, now);
      if (r.attention_note || (mins !== null && mins >= STUCK_AFTER_MINUTES)) c.stuck++;
    } else if (r.refund_status === "requested") {
      if (viewerId !== null && r.requested_by === viewerId) c.waitingOnOthers++;
      else c.toApprove++;
    } else if (r.refund_status === "approved") c.toPay++;
  }
  return c;
}

export type Task = { key: string; count: number; label: string; href: string; tone: "critical" | "normal" };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Live maintenance requests the viewer can read, as the overview needs them. Row level security decides what comes
 * back, so a role that cannot read maintenance gets zeros and no repair line appears for it.
 */
export type RepairCounts = { open: number; overdue: number; highPriority: number };

export function countRepairs(rows: RequestBrief[], now: Date): RepairCounts {
  const c = countRequests(rows, "", now);
  return { open: c.open, overdue: c.overdue, highPriority: c.highPriority };
}

/** A room's two status columns, as the overview reads them. */
export type RoomBrief = { housekeeping_status: string; operational_status: string };

/**
 * Rooms still waiting for a cleaner: dirty or being cleaned. A retired room is not cleaned, so it is left out; a room out
 * of service is counted, because it still has to be made ready before it goes back on sale.
 */
export function countCleaning(rows: RoomBrief[]): { toClean: number; inProgress: number; total: number } {
  let toClean = 0;
  let inProgress = 0;
  for (const r of rows) {
    if (r.operational_status === "retired") continue;
    if (r.housekeeping_status === "dirty") toClean++;
    else if (r.housekeeping_status === "in_progress") inProgress++;
  }
  return { toClean, inProgress, total: toClean + inProgress };
}

export type OverviewInput = {
  desk: Pick<DeskGroups, "overdue" | "lateArrivals">;
  flaggedReservations: number;
  refunds: RefundCounts;
  repairs: RepairCounts;
  failedEmails: number;
};

/** The things that need a person, most urgent first. Anything at zero is left out. */
export function buildTasks(i: OverviewInput): Task[] {
  const all: Task[] = [
    { key: "overdue", count: i.desk.overdue.length, tone: "critical", href: "/app/front-desk",
      label: plural(i.desk.overdue.length, "guest is still in house past their departure date", "guests are still in house past their departure date") },
    { key: "flagged", count: i.flaggedReservations, tone: "critical", href: "/app/reservations?status=attention",
      label: plural(i.flaggedReservations, "reservation is flagged for attention", "reservations are flagged for attention") },
    { key: "stuck", count: i.refunds.stuck, tone: "critical", href: "/app/refunds",
      label: plural(i.refunds.stuck, "refund payout has an unknown or overdue result", "refund payouts have an unknown or overdue result") },
    { key: "repairsOverdue", count: i.repairs.overdue, tone: "critical", href: "/app/maintenance",
      label: plural(i.repairs.overdue, "repair is overdue", "repairs are overdue") },
    { key: "toApprove", count: i.refunds.toApprove, tone: "normal", href: "/app/refunds",
      label: plural(i.refunds.toApprove, "refund is waiting for your approval", "refunds are waiting for your approval") },
    { key: "toPay", count: i.refunds.toPay, tone: "normal", href: "/app/refunds",
      label: plural(i.refunds.toPay, "approved refund is ready to pay out", "approved refunds are ready to pay out") },
    { key: "repairsHigh", count: i.repairs.highPriority, tone: "normal", href: "/app/maintenance",
      label: plural(i.repairs.highPriority, "urgent or high-priority repair is open", "urgent or high-priority repairs are open") },
    { key: "emails", count: i.failedEmails, tone: "normal", href: "/app/emails",
      label: plural(i.failedEmails, "guest email could not be delivered", "guest emails could not be delivered") },
    { key: "late", count: i.desk.lateArrivals.length, tone: "normal", href: "/app/front-desk",
      label: plural(i.desk.lateArrivals.length, "confirmed guest has not arrived yet", "confirmed guests have not arrived yet") },
  ];
  return all.filter((t) => t.count > 0);
}

/** Figures for the "today" strip. In house counts everyone checked in, including those leaving today or overdue. */
export function todayFigures(g: DeskGroups): { arriving: number; departing: number; inHouse: number } {
  return { arriving: g.arrivals.length, departing: g.departures.length, inHouse: g.inHouse.length + g.departures.length + g.overdue.length };
}
