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
    return (
      <p role="alert" className="mb-5 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">
        {errorMessage(err, refundable, (m) => formatMoney(m, currency))}
      </p>
    );
  }
  const text = ok && ok in OK_MESSAGES ? OK_MESSAGES[ok as OkCode] : null;
  if (!text) return null;
  return (
    <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">{text}</p>
  );
}

export const buttonPrimary =
  "rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50";
export const buttonQuiet =
  "rounded border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50";
export const buttonDanger =
  "rounded border border-critical/40 bg-white px-3 py-1.5 text-sm font-medium text-critical hover:bg-critical/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical";
export const inputClass =
  "w-full rounded border border-line bg-white px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary";
