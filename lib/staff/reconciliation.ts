/**
 * Payment reconciliation: compare a Paystack transactions CSV (Dashboard, Transactions, Export CSV) with the Paystack
 * payments the system recorded. Pure functions, so they can be tested without a database or a file upload.
 *
 * What the file looks like is not under our control: the Dashboard lets the person choose the columns, the names can
 * change, and its amounts are not documented as naira or kobo. So columns are found by header name, and the unit is
 * either chosen by the person or worked out from the data (`detectUnit`), never assumed.
 *
 * Nothing here writes anything. It reports differences for a person to look at.
 */

export const MAX_FILE_BYTES = 2_000_000;
export const MAX_ROWS = 20_000;

export type AmountUnit = "naira" | "kobo";
export type ProviderStatus = "success" | "failed" | "abandoned" | "reversed" | "other";

export type ProviderRow = {
  /** Line in the file (the header is line 1). */
  line: number;
  reference: string;
  amountText: string;
  status: ProviderStatus;
  statusText: string;
  currency: string | null;
};

/** A Paystack payment as the system recorded it. */
export type OurPayment = {
  id: string;
  reservation_id: string;
  reference: string;
  amount_minor: number;
  currency: string;
  payment_status: "succeeded" | "reversed";
};

// ---- CSV ------------------------------------------------------------------------------------------------------

/** Reads CSV text (RFC 4180: quotes, doubled quotes, line breaks inside quotes, CRLF or LF, an optional byte order mark). */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let touched = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      touched = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      touched = true;
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (touched || field !== "") {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      touched = false;
      continue;
    }
    field += c;
    touched = true;
  }
  if (quoted) throw new Error("The file ends inside a quoted value, so it is not a complete CSV file.");
  if (touched || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const normalizeHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Header names we accept, best first. */
const ALIASES = {
  reference: ["reference", "transaction reference", "transaction ref", "txn reference", "ref"],
  amount: ["amount", "amount paid", "paid amount", "transaction amount", "amount ngn"],
  status: ["status", "transaction status"],
  currency: ["currency"],
} as const;

function findColumn(headers: string[], aliases: readonly string[]): number {
  for (const alias of aliases) {
    const at = headers.indexOf(alias);
    if (at !== -1) return at;
  }
  return -1;
}

export function statusOf(text: string): ProviderStatus {
  const t = text.trim().toLowerCase();
  if (t === "success" || t === "successful") return "success";
  if (t === "failed" || t === "failure") return "failed";
  if (t === "abandoned") return "abandoned";
  if (t === "reversed") return "reversed";
  return "other";
}

export type ReadResult = {
  rows: ProviderRow[];
  /** Things that stop the comparison or that the person should know about. A missing column stops it. */
  problems: string[];
  /** True when the file cannot be compared at all. */
  fatal: boolean;
  columns: { reference: string; amount: string; status: string; currency: string | null } | null;
};

export function readProviderRows(csv: string): ReadResult {
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (e) {
    return { rows: [], problems: [(e as Error).message], fatal: true, columns: null };
  }
  if (table.length === 0) return { rows: [], problems: ["The file is empty."], fatal: true, columns: null };
  const rawHeaders = table[0]!;
  const headers = rawHeaders.map(normalizeHeader);
  const ref = findColumn(headers, ALIASES.reference);
  const amt = findColumn(headers, ALIASES.amount);
  const sta = findColumn(headers, ALIASES.status);
  const cur = findColumn(headers, ALIASES.currency);
  const missing = [ref < 0 ? "reference" : "", amt < 0 ? "amount" : "", sta < 0 ? "status" : ""].filter(Boolean);
  if (missing.length > 0) {
    return {
      rows: [],
      fatal: true,
      columns: null,
      problems: [
        `The file has no ${missing.join(", ")} column. Export again with those columns included. The columns found were: ${
          rawHeaders
            .map((h) => h.trim())
            .filter(Boolean)
            .join(", ") || "none"
        }.`,
      ],
    };
  }
  if (table.length - 1 > MAX_ROWS) {
    return {
      rows: [],
      fatal: true,
      columns: null,
      problems: [`The file has more than ${MAX_ROWS.toLocaleString("en")} rows. Export a shorter period.`],
    };
  }

  const problems: string[] = [];
  const rows: ProviderRow[] = [];
  let blank = 0;
  for (let i = 1; i < table.length; i++) {
    const r = table[i]!;
    const reference = (r[ref] ?? "").trim();
    if (reference === "") {
      blank++;
      continue;
    }
    const statusText = (r[sta] ?? "").trim();
    rows.push({
      line: i + 1,
      reference,
      amountText: (r[amt] ?? "").trim(),
      status: statusOf(statusText),
      statusText,
      currency: cur >= 0 ? (r[cur] ?? "").trim().toUpperCase() || null : null,
    });
  }
  if (blank > 0) problems.push(`${blank} row${blank === 1 ? " has" : "s have"} no reference and ${blank === 1 ? "was" : "were"} skipped.`);
  return {
    rows,
    problems,
    fatal: false,
    columns: {
      reference: rawHeaders[ref]!.trim(),
      amount: rawHeaders[amt]!.trim(),
      status: rawHeaders[sta]!.trim(),
      currency: cur >= 0 ? rawHeaders[cur]!.trim() : null,
    },
  };
}

// ---- Amounts --------------------------------------------------------------------------------------------------

/**
 * "1,500.50" read as naira, or "150050" read as kobo, to whole kobo, with no floating point. Returns null for anything
 * that is not a plain non-negative amount (a symbol or NGN prefix and thousands commas are allowed).
 */
export function decimalToMinor(text: string, unit: AmountUnit): number | null {
  const t = text
    .trim()
    .replace(/^(?:NGN|₦)\s*/i, "")
    .replace(/,/g, "");
  const m = /^(\d{1,13})(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (unit === "kobo") {
    if (/[^0]/.test(frac)) return null;
    return Number(whole);
  }
  if (frac.length > 2 && /[^0]/.test(frac.slice(2))) return null;
  return Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, "0"));
}

/**
 * Which unit the file's amounts are in, judged by how many successful rows agree with our own records under each
 * reading. Returns null when it cannot tell (no row's reference is on both sides, or both readings agree equally).
 */
export function detectUnit(rows: ProviderRow[], ours: OurPayment[]): { unit: AmountUnit | null; naira: number; kobo: number } {
  const byRef = new Map(ours.map((p) => [p.reference, p]));
  let naira = 0;
  let kobo = 0;
  for (const r of rows) {
    if (r.status !== "success") continue;
    const p = byRef.get(r.reference);
    if (!p) continue;
    if (decimalToMinor(r.amountText, "naira") === p.amount_minor) naira++;
    if (decimalToMinor(r.amountText, "kobo") === p.amount_minor) kobo++;
  }
  return { unit: naira > kobo ? "naira" : kobo > naira ? "kobo" : null, naira, kobo };
}

// ---- Matching -------------------------------------------------------------------------------------------------

export type Finding =
  | { kind: "missing_here"; reference: string; line: number; providerMinor: number; currency: string | null }
  | {
      kind: "amount_differs";
      reference: string;
      line: number;
      providerMinor: number;
      ourMinor: number;
      paymentId: string;
      reservationId: string;
    }
  | {
      kind: "currency_differs";
      reference: string;
      line: number;
      providerCurrency: string;
      ourCurrency: string;
      paymentId: string;
      reservationId: string;
    }
  | {
      kind: "not_successful_at_provider";
      reference: string;
      line: number;
      providerStatus: string;
      ourMinor: number;
      paymentId: string;
      reservationId: string;
    }
  | { kind: "reversed_at_provider"; reference: string; line: number; ourMinor: number; paymentId: string; reservationId: string }
  | { kind: "reversed_here"; reference: string; line: number; providerMinor: number; paymentId: string; reservationId: string }
  | { kind: "not_in_file"; reference: string; ourMinor: number; paymentId: string; reservationId: string }
  | { kind: "bad_amount"; reference: string; line: number; amountText: string }
  | { kind: "duplicate_in_file"; reference: string; lines: number[] };

export type FindingKind = Finding["kind"];

/** Most serious first: money Paystack has that we do not show, then the rest. */
export const KIND_ORDER: FindingKind[] = [
  "missing_here",
  "amount_differs",
  "currency_differs",
  "not_successful_at_provider",
  "reversed_at_provider",
  "reversed_here",
  "not_in_file",
  "bad_amount",
  "duplicate_in_file",
];

export type ReconcileResult = {
  fileRows: number;
  /** Successful in the file and the same payment here, same amount and currency. */
  matched: number;
  matchedMinor: number;
  /** Rows that need nothing: failed or abandoned with no payment here, or reversed on both sides. */
  ignored: number;
  findings: Finding[];
};

/**
 * `ours` must be the Paystack payments for the same property and the same days the file covers, or "not in file"
 * will list payments the file was never meant to hold.
 */
export function reconcile(rows: ProviderRow[], ours: OurPayment[], unit: AmountUnit): ReconcileResult {
  const byRef = new Map(ours.map((p) => [p.reference, p]));
  const seen = new Map<string, number[]>();
  const findings: Finding[] = [];
  let matched = 0,
    matchedMinor = 0,
    ignored = 0;

  for (const r of rows) {
    const lines = seen.get(r.reference);
    if (lines) {
      lines.push(r.line);
      continue;
    }
    seen.set(r.reference, [r.line]);
    const p = byRef.get(r.reference);

    if (r.status === "success") {
      const minor = decimalToMinor(r.amountText, unit);
      if (minor === null) {
        findings.push({ kind: "bad_amount", reference: r.reference, line: r.line, amountText: r.amountText });
        continue;
      }
      if (!p) {
        findings.push({ kind: "missing_here", reference: r.reference, line: r.line, providerMinor: minor, currency: r.currency });
        continue;
      }
      if (p.payment_status === "reversed") {
        findings.push({
          kind: "reversed_here",
          reference: r.reference,
          line: r.line,
          providerMinor: minor,
          paymentId: p.id,
          reservationId: p.reservation_id,
        });
        continue;
      }
      if (r.currency && r.currency !== p.currency.toUpperCase()) {
        findings.push({
          kind: "currency_differs",
          reference: r.reference,
          line: r.line,
          providerCurrency: r.currency,
          ourCurrency: p.currency,
          paymentId: p.id,
          reservationId: p.reservation_id,
        });
        continue;
      }
      if (minor !== p.amount_minor) {
        findings.push({
          kind: "amount_differs",
          reference: r.reference,
          line: r.line,
          providerMinor: minor,
          ourMinor: p.amount_minor,
          paymentId: p.id,
          reservationId: p.reservation_id,
        });
        continue;
      }
      matched++;
      matchedMinor += minor;
      continue;
    }

    if (!p || p.payment_status === "reversed") {
      ignored++;
      continue;
    }
    if (r.status === "reversed") {
      findings.push({
        kind: "reversed_at_provider",
        reference: r.reference,
        line: r.line,
        ourMinor: p.amount_minor,
        paymentId: p.id,
        reservationId: p.reservation_id,
      });
    } else {
      findings.push({
        kind: "not_successful_at_provider",
        reference: r.reference,
        line: r.line,
        providerStatus: r.statusText || "unknown",
        ourMinor: p.amount_minor,
        paymentId: p.id,
        reservationId: p.reservation_id,
      });
    }
  }

  for (const [reference, lines] of seen) if (lines.length > 1) findings.push({ kind: "duplicate_in_file", reference, lines });
  for (const p of ours) {
    if (p.payment_status === "succeeded" && !seen.has(p.reference)) {
      findings.push({
        kind: "not_in_file",
        reference: p.reference,
        ourMinor: p.amount_minor,
        paymentId: p.id,
        reservationId: p.reservation_id,
      });
    }
  }

  findings.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.reference.localeCompare(b.reference));
  return { fileRows: rows.length, matched, matchedMinor, ignored, findings };
}
