"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, buttonQuiet, inputClass } from "./ui";

type Bank = { id: string; name: string };
type Outcome = { status?: string; reason?: string; note?: string; error?: string };

/**
 * Collects the customer's bank details for a refund Paystack could not finish on its own, and sends them once.
 * Paystack's retry cannot be asked twice, so the form reviews the details before sending and locks after the click.
 * The account number lives only in this component's state and the one request: it is cleared when the form closes
 * and is never stored by the server or shown again.
 */
export function RefundDetailsForm({ refundId }: { refundId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"closed" | "loading" | "form" | "review" | "sending" | "done">("closed");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<{ text: string; tone: "ok" | "warn" | "bad" } | null>(null);

  const digits = account.replace(/[\s-]/g, "");
  const bankName = banks.find((b) => b.id === bankId)?.name ?? "";

  async function open() {
    setError(null);
    setPhase("loading");
    try {
      const res = await fetch(`/api/staff/refunds/${refundId}/banks`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { banks?: Bank[]; error?: string };
      if (!res.ok || !body.banks?.length) {
        setError(res.status === 404 ? "Refund not found, or you cannot send bank details for it." : "Could not load the list of banks. Try again in a moment.");
        setPhase("closed");
        return;
      }
      setBanks(body.banks);
      setPhase("form");
    } catch {
      setError("Could not load the list of banks. Check the connection and try again.");
      setPhase("closed");
    }
  }

  function review(e: React.FormEvent) {
    e.preventDefault();
    if (!bankId) return setError("Choose the bank.");
    if (!/^\d{5,20}$/.test(digits)) return setError("Enter the account number using digits only.");
    setError(null);
    setPhase("review");
  }

  async function send() {
    setPhase("sending");
    try {
      const res = await fetch(`/api/staff/refunds/${refundId}/details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankId, accountNumber: digits }),
      });
      const body = (await res.json().catch(() => ({}))) as Outcome;
      if (body.status === "submitted") {
        setDoneMessage({ tone: "ok", text: "Sent to Paystack. It will show as paid out here when Paystack confirms." });
      } else if (body.status === "already_started") {
        setDoneMessage({ tone: "warn", text: "Someone else already sent bank details for this refund." });
      } else if (body.status === "unknown") {
        setDoneMessage({ tone: "warn", text: "Paystack did not answer clearly. Do not send the details again: check the refund on the Paystack dashboard." });
      } else if (body.status === "rejected") {
        // Nothing was sent, so the details can be corrected and sent again.
        setError(`Paystack refused the details: ${body.reason ?? "no reason given"}. Check the bank and account number and try again.`);
        setPhase("form");
        return;
      } else if (res.status === 400) {
        setError(body.error === "bank_required" ? "Choose the bank." : "The account number is not valid for this bank. Check it and try again.");
        setPhase("form");
        return;
      } else if (res.status === 409) {
        setDoneMessage({ tone: "warn", text: "This refund has already moved on. Reload the page." });
      } else {
        setDoneMessage({ tone: "bad", text: res.status === 404 ? "Refund not found, or you cannot send bank details for it." : "The call failed. Reload and check the refund before trying again." });
      }
    } catch {
      setDoneMessage({ tone: "warn", text: "The connection dropped. The details may have been sent: reload and check before trying again." });
    }
    setAccount("");
    setPhase("done");
    router.refresh();
  }

  if (phase === "done" && doneMessage) {
    const color = doneMessage.tone === "ok" ? "text-primary-strong" : doneMessage.tone === "warn" ? "text-pending" : "text-critical";
    return <p role="status" className={`max-w-xs text-sm ${color}`}>{doneMessage.text}</p>;
  }

  if (phase === "closed" || phase === "loading") {
    return (
      <div className="space-y-2">
        <button type="button" onClick={open} disabled={phase === "loading"} className={buttonPrimary}>
          {phase === "loading" ? "Loading banks…" : "Enter bank details"}
        </button>
        {error && <p role="alert" className="max-w-xs text-sm text-critical">{error}</p>}
      </div>
    );
  }

  if (phase === "review" || phase === "sending") {
    return (
      <div className="space-y-3">
        <p className="max-w-xs text-sm">
          Send the refund to account ending <strong>{digits.slice(-4)}</strong> at <strong>{bankName}</strong>? Paystack cannot be asked twice, so check this is right.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={send} disabled={phase === "sending"} className={buttonPrimary}>{phase === "sending" ? "Sending…" : "Send to Paystack"}</button>
          {phase === "review" && <button type="button" onClick={() => setPhase("form")} className={buttonQuiet}>Change</button>}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={review} className="space-y-2" autoComplete="off">
      <p className="max-w-xs text-sm text-muted">Any valid account in the guest&apos;s name works, even if it is not the one they paid from.</p>
      <label className="block text-sm" htmlFor={`bank-${refundId}`}>Bank</label>
      <select id={`bank-${refundId}`} value={bankId} onChange={(e) => setBankId(e.target.value)} required className={inputClass}>
        <option value="">Choose a bank</option>
        {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <label className="block text-sm" htmlFor={`acct-${refundId}`}>Account number</label>
      <input id={`acct-${refundId}`} value={account} onChange={(e) => setAccount(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={24} required className={inputClass} />
      {error && <p role="alert" className="max-w-xs text-sm text-critical">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={buttonPrimary}>Review</button>
        <button type="button" onClick={() => { setAccount(""); setError(null); setPhase("closed"); }} className={buttonQuiet}>Cancel</button>
      </div>
    </form>
  );
}
