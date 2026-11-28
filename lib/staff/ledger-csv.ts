import { csvField, major } from "./reports-csv";

/** One row of `money_ledger` (migration 193). Money is in minor units; a refund is negative. */
export type LedgerRow = {
  entry_at: string;
  entry_day: string;
  kind: "booking_payment" | "extras_payment" | "refund";
  internal_reference: string | null;
  provider_reference: string | null;
  booking_reference: string | null;
  guest_name: string | null;
  method: string | null;
  provider: string | null;
  group_reference: string | null;
  amount_minor: number;
  currency: string;
  note: string | null;
};

/** The most rows one download holds. A bigger period is refused whole: a file that silently stops short would be worse than none. */
export const MAX_LEDGER_ROWS = 50_000;
/** Rows asked for per request. The API returns at most 1000 for one call, so a long period is read in pages. */
export const LEDGER_PAGE = 1000;

const KIND_LABEL: Record<LedgerRow["kind"], string> = {
  booking_payment: "Booking payment",
  extras_payment: "Extras payment",
  refund: "Refund",
};

const METHOD_LABEL: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", pos: "POS", other: "Other" };

/**
 * A free-text field, safe to open in a spreadsheet. `csvField` stops a leading = + @ (and tab, return) from running as a formula but
 * leaves a leading "-" alone, because it also carries negative amounts such as "-1500.00". Text must not get that exception: a guest
 * name or note that starts with "-" can be a formula too. Amounts go through `csvField` (they are numbers), text through here.
 */
export function csvText(v: string | null | undefined): string {
  const s = v ?? "";
  return csvField(/^-/.test(s) ? `'${s}` : s);
}

/** "2026-11-24T14:05:44+00:00" or a Date string to "2026-11-24 14:05" in UTC, the exact time of the entry. */
function utcMinute(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "";
}

export function ledgerCsv(rows: LedgerRow[]): string {
  const head = [
    "Date",
    "Time (UTC)",
    "Type",
    "Booking",
    "Guest",
    "Method",
    "Online provider",
    "Reference",
    "Provider reference",
    "Company payment reference",
    "Amount",
    "Currency",
    "Note",
  ];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvText(r.entry_day),
        csvText(utcMinute(r.entry_at)),
        csvText(KIND_LABEL[r.kind] ?? r.kind),
        csvText(r.booking_reference),
        csvText(r.guest_name),
        csvText(r.method ? (METHOD_LABEL[r.method] ?? r.method) : ""),
        csvText(r.provider),
        csvText(r.internal_reference),
        csvText(r.provider_reference),
        csvText(r.group_reference),
        csvField(major(Number(r.amount_minor))),
        csvText(r.currency),
        csvText(r.note),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function ledgerFileName(propertyName: string, from: string, to: string): string {
  const slug =
    propertyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "hotel";
  return `ledger-${slug}-${from}-to-${to}.csv`;
}
