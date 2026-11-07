"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMoney } from "@/lib/guest-site/format";
import type { Finding, FindingKind, ReconcileResult } from "@/lib/staff/reconciliation";
import { buttonPrimary, cardClass, inputClass, linkClass, ErrorBanner } from "@/components/staff/ui";

type Property = { id: string; name: string };
type Response = {
  range: { from: string; to: string };
  unit: "naira" | "kobo";
  unitSource: "chosen" | "detected";
  columns: { reference: string; amount: string; status: string; currency: string | null };
  problems: string[];
  recordedHere: number;
  result: ReconcileResult;
};

const WHAT: Record<FindingKind, { title: string; help: string }> = {
  missing_here: { title: "Paid at Paystack, not recorded here", help: "Paystack shows these as successful but there is no payment here. The guest may have paid while the confirmation never arrived. Find the booking and check it." },
  amount_differs: { title: "Different amount", help: "The same reference is on both sides, with different amounts." },
  currency_differs: { title: "Different currency", help: "The same reference is on both sides, in different currencies." },
  not_successful_at_provider: { title: "Recorded here as paid, not successful at Paystack", help: "The payment here may not have been money received. Check with Paystack before relying on it." },
  reversed_at_provider: { title: "Reversed at Paystack, still counted here", help: "Paystack took this payment back. It still counts as received here." },
  reversed_here: { title: "Reversed here, successful at Paystack", help: "Someone reversed this payment here, but Paystack still shows it as successful." },
  not_in_file: { title: "Recorded here, not in the file", help: "Check that the file covers the same days. If it does, the payment may be missing at Paystack." },
  bad_amount: { title: "Amount could not be read", help: "Open the file at that line and check the amount." },
  duplicate_in_file: { title: "Listed more than once in the file", help: "Only the first line was compared." },
};

function describe(f: Finding, unitNote: (minor: number) => string): string {
  switch (f.kind) {
    case "missing_here": return `${unitNote(f.providerMinor)}${f.currency && f.currency !== "NGN" ? ` ${f.currency}` : ""} · line ${f.line}`;
    case "amount_differs": return `Paystack ${unitNote(f.providerMinor)}, here ${unitNote(f.ourMinor)} · line ${f.line}`;
    case "currency_differs": return `Paystack ${f.providerCurrency}, here ${f.ourCurrency} · line ${f.line}`;
    case "not_successful_at_provider": return `Paystack says “${f.providerStatus}”, here ${unitNote(f.ourMinor)} · line ${f.line}`;
    case "reversed_at_provider": return `${unitNote(f.ourMinor)} · line ${f.line}`;
    case "reversed_here": return `Paystack ${unitNote(f.providerMinor)} · line ${f.line}`;
    case "not_in_file": return unitNote(f.ourMinor);
    case "bad_amount": return `“${f.amountText}” · line ${f.line}`;
    case "duplicate_in_file": return `lines ${f.lines.join(", ")}`;
  }
}

export function ReconciliationForm({ properties, defaultFrom, defaultTo }: { properties: Property[]; defaultFrom: string; defaultTo: string }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Response | null>(null);

  async function run(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setData(null); setRunning(true);
    try {
      const res = await fetch("/api/staff/reconciliation", { method: "POST", body: new FormData(e.currentTarget) });
      const body = (await res.json().catch(() => ({}))) as Partial<Response> & { error?: string };
      if (!res.ok) setError(body.error ?? "Something went wrong. Try again in a moment.");
      else setData(body as Response);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setRunning(false);
    }
  }

  const money = (minor: number) => formatMoney(minor, "NGN");
  const grouped = data ? (Object.keys(WHAT) as FindingKind[]).map((k) => ({ kind: k, items: data.result.findings.filter((f) => f.kind === k) })).filter((g) => g.items.length > 0) : [];

  return (
    <div>
      <form onSubmit={run} className="grid gap-4 rounded border border-line bg-white p-4 sm:grid-cols-2">
        {properties.length > 1 ? (
          <label className="text-sm sm:col-span-2">Property
            <select name="property" className={`${inputClass} mt-1`} required>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
        ) : <input type="hidden" name="property" value={properties[0]!.id} />}
        <label className="text-sm">First day the export covers
          <input type="date" name="from" defaultValue={defaultFrom} className={`${inputClass} mt-1`} required />
        </label>
        <label className="text-sm">Last day the export covers
          <input type="date" name="to" defaultValue={defaultTo} className={`${inputClass} mt-1`} required />
        </label>
        <label className="text-sm">Amounts in the file are in
          <select name="unit" defaultValue="auto" className={`${inputClass} mt-1`}>
            <option value="auto">Work it out from the file</option>
            <option value="naira">Naira (1,500.00)</option>
            <option value="kobo">Kobo (150000)</option>
          </select>
        </label>
        <label className="text-sm">Paystack transactions CSV
          <input type="file" name="file" accept=".csv,text/csv" className={`${inputClass} mt-1`} required />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" disabled={running} className={`${buttonPrimary} disabled:opacity-60`}>{running ? "Comparing…" : "Compare"}</button>
        </div>
      </form>

      {error && <ErrorBanner className="mt-4">{error}</ErrorBanner>}

      {data && (
        <div className="mt-6" aria-live="polite">
          <h2 className="font-display text-lg">Result for {data.range.from} to {data.range.to}</h2>
          <p className="mt-1 text-sm text-muted">
            {data.result.fileRows.toLocaleString("en")} rows in the file, {data.recordedHere.toLocaleString("en")} Paystack payments recorded here.
            Amounts read as {data.unit}{data.unitSource === "detected" ? " (worked out from the file)" : ""}.
            Columns used: {data.columns.reference}, {data.columns.amount}, {data.columns.status}{data.columns.currency ? `, ${data.columns.currency}` : ""}.
          </p>
          {data.problems.map((p) => <p key={p} className="mt-2 text-sm text-pending">{p}</p>)}

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className={cardClass}><p className="text-xs text-muted">Matched</p><p className="text-lg font-medium">{data.result.matched.toLocaleString("en")}</p><p className="text-xs text-muted">{money(data.result.matchedMinor)}</p></div>
            <div className={cardClass}><p className="text-xs text-muted">Need a look</p><p className="text-lg font-medium">{data.result.findings.length.toLocaleString("en")}</p></div>
            <div className={cardClass}><p className="text-xs text-muted">Nothing to do</p><p className="text-lg font-medium">{data.result.ignored.toLocaleString("en")}</p><p className="text-xs text-muted">failed or abandoned, never recorded here</p></div>
          </div>

          {grouped.length === 0 && <p className={`mt-4 ${cardClass} text-sm`}>Everything in the file matches what is recorded here.</p>}

          {grouped.map((g) => (
            <section key={g.kind} className="mt-6">
              <h3 className="font-medium">{WHAT[g.kind].title} <span className="text-muted">({g.items.length})</span></h3>
              <p className="mt-1 text-sm text-muted">{WHAT[g.kind].help}</p>
              <div className="mt-2 overflow-x-auto rounded border border-line bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="bg-paper text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Reference</th><th className="px-3 py-2 font-medium">Detail</th><th className="px-3 py-2 font-medium">Booking</th></tr></thead>
                  <tbody>
                    {g.items.map((f) => (
                      <tr key={`${f.kind}-${f.reference}`} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-xs">{f.reference}</td>
                        <td className="px-3 py-2">{describe(f, money)}</td>
                        <td className="px-3 py-2">{"reservationId" in f ? <Link href={`/app/reservations/${f.reservationId}`} className={linkClass}>Open</Link> : <span className="text-muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
