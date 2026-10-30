export type OutgoingEmail = { to: string; subject: string; text: string; html: string; idempotencyKey: string };
export interface Mailer {
  send(message: OutgoingEmail): Promise<void>;
}

/**
 * Resend (checked against Resend's docs, October 2026): POST /emails with a bearer key and
 * {from, to, subject, html, text}; the Idempotency-Key header (unique per request, kept 24 hours)
 * stops a retried request from sending twice. We pass the outbox row id, so a row reclaimed after a
 * crash cannot produce a second email.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly baseUrl: string = "https://api.resend.com",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(m: OutgoingEmail): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": m.idempotencyKey },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
      cache: "no-store",
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = String(((await res.json()) as { message?: unknown }).message ?? "").slice(0, 200);
      } catch {
        /* body was not JSON */
      }
      throw new Error(`Resend HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
  }
}

/** Development transport: prints a masked recipient and the subject, never the body or the link. */
export class LogMailer implements Mailer {
  async send(m: OutgoingEmail): Promise<void> {
    const [local = "", domain = ""] = m.to.split("@");
    console.log(`[email:log] to=${local.slice(0, 1)}***@${domain} subject=${JSON.stringify(m.subject)}`);
  }
}

/**
 * Returns null when email is not configured. Callers then leave the outbox alone, so mail waits
 * instead of being marked sent without going anywhere. EMAIL_TRANSPORT=log opts in to the log mailer.
 */
export function createMailer(env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): Mailer | null {
  if (env.EMAIL_TRANSPORT === "log") return new LogMailer();
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    return new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM, env.RESEND_API_BASE_URL ?? "https://api.resend.com", fetchFn);
  }
  return null;
}
