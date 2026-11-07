import { errorMessage, OK_MESSAGES, type OkCode } from "@/lib/staff/refunds";
import { formatMoney } from "@/lib/guest-site/format";
import { PAYMENT_LABEL, STATUS_LABEL } from "@/lib/staff/reservations";

const CHIP: Record<string, string> = {
  requested: "bg-pending/10 text-pending",
  approved: "bg-primary/10 text-primary-strong",
  processing: "bg-navy-800/10 text-navy-800",
  succeeded: "bg-primary/10 text-primary-strong",
  rejected: "bg-ink/10 text-muted",
  failed: "bg-critical/10 text-critical",
  attention: "bg-critical/10 text-critical",
};
const LABEL: Record<string, string> = {
  requested: "Awaiting approval", approved: "Approved", processing: "Paying out", succeeded: "Paid out",
  rejected: "Rejected", failed: "Failed", attention: "Needs a person",
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${CHIP[status] ?? "bg-ink/10 text-muted"}`}>
      {LABEL[status] ?? status}
    </span>
  );
}

const RES_CHIP: Record<string, string> = {
  pending: "bg-pending/10 text-pending",
  confirmed: "bg-primary/10 text-primary-strong",
  checked_in: "bg-navy-800/10 text-navy-800",
  checked_out: "bg-ink/10 text-muted",
  cancelled: "bg-critical/10 text-critical",
  no_show: "bg-critical/10 text-critical",
  expired: "bg-ink/10 text-muted",
};
const PAY_CHIP: Record<string, string> = {
  paid: "bg-primary/10 text-primary-strong",
  partially_paid: "bg-pending/10 text-pending",
  unpaid: "bg-ink/10 text-muted",
  partially_refunded: "bg-navy-800/10 text-navy-800",
  refunded: "bg-navy-800/10 text-navy-800",
  payment_failed: "bg-critical/10 text-critical",
};

export function ReservationChip({ status }: { status: string }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${RES_CHIP[status] ?? "bg-ink/10 text-muted"}`}>{STATUS_LABEL[status] ?? status}</span>;
}
export function PaymentChip({ status }: { status: string }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${PAY_CHIP[status] ?? "bg-ink/10 text-muted"}`}>{PAYMENT_LABEL[status] ?? status}</span>;
}

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last action, read from ?ok= / ?err=. Both are short codes, never free text. */
export function Notice({ search, currency }: { search: Search; currency: string }) {
  const ok = one(search.ok);
  const err = one(search.err);
  if (!ok && !err) return null;
  if (err) {
    const n = one(search.n);
    const refundable = n && /^\d+$/.test(n) ? Number(n) : null;
    return <ErrorBanner className="mb-5">{errorMessage(err, refundable, (m) => formatMoney(m, currency))}</ErrorBanner>;
  }
  const text = ok && ok in OK_MESSAGES ? OK_MESSAGES[ok as OkCode] : null;
  if (!text) return null;
  return (
    <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">{text}</p>
  );
}

/** Link text inside a page: teal and underlined (back links, links in a table row, "Download as CSV"). */
export const linkClass = "text-primary-strong underline underline-offset-2";

// Table styles shared by the report and list tables.
/** A header cell over a column of numbers. */
export const thNum = "px-2 py-2 text-right font-normal";
/** A cell holding a number or an amount. */
export const tdNum = "px-2 py-2 text-right";
/** The header cell that names its row (the first column). */
export const thRowHead = "py-2 pr-3 text-left font-normal";
/** The row of column headings. */
export const headRow = "border-b border-line text-left text-muted";
/** The totals row at the foot of a table. */
export const totalRow = "font-semibold tabular-nums";

const withClass = (extra: string | undefined, base: string) => (extra ? `${extra} ${base}` : base);

/** A failure to load or to act: a red bar on the left, read out by screen readers. `className` carries the spacing, for example "mt-6". */
export function ErrorBanner({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p role="alert" className={withClass(className, "border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical")}>{children}</p>;
}

/** A box that says there is nothing to show, or that this person may not see it. `className` carries the spacing. */
export function EmptyState({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={withClass(className, "rounded border border-line bg-white px-4 py-6 text-muted")}>{children}</p>;
}

/** The heading at the top of a page. `className` carries spacing, for example "mt-2" under a back link. */
export function PageTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h1 className={withClass(className, "font-display text-3xl")}>{children}</h1>;
}

/** The heading of a section within a page. Pass `id` when the section is named by `aria-labelledby`. */
export function SectionTitle({ id, children }: { id?: string; children: React.ReactNode }) {
  return <h2 id={id} className="font-display text-xl">{children}</h2>;
}

/** The grey paragraph under a page heading. */
export function PageIntro({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 max-w-prose text-muted">{children}</p>;
}

/** The box around one item in a grid or list: a room, a task, a repair, a form. Add layout classes after it, for example `${cardClass} grid gap-3`. */
export const cardClass = "rounded border border-line bg-white p-3";

/** The top line of a room card: the room number on the left, a chip or a small grey note (floor, hotel) on the right. */
export function RoomCardHeader({ roomNumber, children }: { roomNumber: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-lg font-semibold">{roomNumber}</span>
      {children}
    </div>
  );
}

/** A figure with its label above and a note below (the totals on the report pages). */
export function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded border border-line bg-white p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  );
}

export const buttonPrimary =
  "rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:justify-center";
export const buttonQuiet =
  "rounded border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:justify-center";
export const buttonDanger =
  "rounded border border-critical/40 bg-white px-3 py-1.5 text-sm font-medium text-critical hover:bg-critical/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:justify-center";
export const inputClass =
  "w-full rounded border border-line bg-white px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary";

const MEMBER_CHIP: Record<string, string> = {
  active: "bg-primary/10 text-primary-strong", suspended: "bg-pending/10 text-pending", revoked: "bg-ink/10 text-muted", invited: "bg-navy-800/10 text-navy-800",
};
export function MemberStatusChip({ status }: { status: string }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${MEMBER_CHIP[status] ?? "bg-ink/10 text-muted"}`}>{status}</span>;
}
