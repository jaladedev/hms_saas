"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, buttonQuiet } from "./ui";

type Outcome = { status: string; reason?: string; note?: string; providerStatus?: string; error?: string };

/**
 * Pays an approved card refund out through the provider. Money leaves on the click, and the
 * provider cannot be asked twice, so the button asks for one confirmation and then locks.
 * The server route is the authority: it moves the refund to "processing" for exactly one caller.
 */
export function PayoutButton({ refundId, amountLabel }: { refundId: string; amountLabel: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "confirm" | "sending" | "done">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "warn" | "bad">("ok");

  async function send() {
    setPhase("sending");
    try {
      const res = await fetch(`/api/staff/refunds/${refundId}/payout`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as Outcome;
      if (body.status === "succeeded") { setTone("ok"); setMessage("Paid out through Paystack."); }
      else if (body.status === "submitted") { setTone("ok"); setMessage("Sent to Paystack. It will show as paid out when Paystack confirms."); }
      else if (body.status === "already_started") { setTone("warn"); setMessage("Someone else already started this payout."); }
      else if (body.status === "unknown") { setTone("warn"); setMessage("Paystack did not answer clearly. Do not retry: check the refund on the Paystack dashboard."); }
      else if (body.status === "failed") { setTone("bad"); setMessage(`Paystack refused it: ${body.reason ?? "no reason given"}. The amount can be requested again.`); }
      else if (res.status === 409) { setTone("warn"); setMessage("This refund has already moved on."); }
      else { setTone("bad"); setMessage(res.status === 404 ? "Refund not found, or you cannot pay it out." : "The payout call failed. Reload and check the refund before trying again."); }
    } catch {
      setTone("warn");
      setMessage("The connection dropped. The payout may have started: reload and check before trying again.");
    }
    setPhase("done");
    router.refresh();
  }

  if (phase === "done" && message) {
    const color = tone === "ok" ? "text-primary-strong" : tone === "warn" ? "text-pending" : "text-critical";
    return <p role="status" className={`max-w-xs text-sm ${color}`}>{message}</p>;
  }
  if (phase === "confirm" || phase === "sending") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={send} disabled={phase === "sending"} className={buttonPrimary}>
          {phase === "sending" ? "Paying out…" : `Pay ${amountLabel} now`}
        </button>
        {phase === "confirm" && <button type="button" onClick={() => setPhase("idle")} className={buttonQuiet}>Cancel</button>}
      </div>
    );
  }
  return <button type="button" onClick={() => setPhase("confirm")} className={buttonPrimary}>Pay out via Paystack</button>;
}
