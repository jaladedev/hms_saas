export type SmsChannel = "sms" | "whatsapp";
export type OutgoingSms = { to: string; text: string; channel: SmsChannel; idempotencyKey: string };
export type SmsSendResult = { providerMessageId: string | null };

/** A failed send. `permanent` means retrying cannot help (the provider says the number is not valid), so the row is failed at once. */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean = false,
  ) {
    super(message);
    this.name = "SmsSendError";
  }
}

export interface SmsProvider {
  send(message: OutgoingSms): Promise<SmsSendResult>;
}

const BAD_NUMBER = /invalid|not valid|not a valid|phone|number|recipient|destination/i;
const OUR_SIDE = /balance|credit|fund|api key|api_key|unauthori[sz]ed|sender|forbidden|permission/i;

/**
 * Whether a provider refusal is the number's fault (retrying is pointless) rather than ours (a key, a balance, a sender name,
 * all of which a person fixes and then the row is tried again). HTTP 400 and 422 only; anything else is temporary.
 */
export function isPermanentRefusal(status: number, detail: string): boolean {
  if (status !== 400 && status !== 422) return false;
  if (OUR_SIDE.test(detail)) return false;
  return BAD_NUMBER.test(detail);
}

/**
 * Termii (checked against developers.termii.com, November 2026): POST {base}/api/sms/send with a JSON body
 * {api_key, to, from, sms, type: "plain", channel}. `to` is the number with its country code and no plus. channel "dnd" is the
 * transactional route that also reaches numbers on Nigeria's do-not-disturb list; "generic" does not, so it is not used here.
 * channel "whatsapp" sends the text through WhatsApp. The base address is per account (the Termii dashboard shows it).
 * Termii has no idempotency key, so a text could be sent twice only if the app dies between the provider's answer and the
 * database write; the row is marked straight after the answer to keep that window short.
 */
export class TermiiProvider implements SmsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly senderId: string,
    private readonly baseUrl: string = "https://api.ng.termii.com",
    private readonly whatsappFrom: string | null = null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(m: OutgoingSms): Promise<SmsSendResult> {
    const body = {
      api_key: this.apiKey,
      to: m.to.replace(/^\+/, ""),
      from: m.channel === "whatsapp" ? (this.whatsappFrom ?? this.senderId) : this.senderId,
      sms: m.text,
      type: "plain",
      channel: m.channel === "whatsapp" ? "whatsapp" : "dnd",
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, "")}/api/sms/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) {
      throw new SmsSendError(`Termii request failed: ${e instanceof Error ? e.message : "network error"}`);
    }
    let json: { message_id?: unknown; message?: unknown; code?: unknown } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* the body was not JSON */
    }
    const detail = typeof json.message === "string" ? json.message.slice(0, 200) : "";
    if (!res.ok) throw new SmsSendError(`Termii HTTP ${res.status}${detail ? `: ${detail}` : ""}`, isPermanentRefusal(res.status, detail));
    // A 200 with an error code in the body is still a failure; Termii answers code "ok" when the message was accepted.
    if (typeof json.code === "string" && json.code.toLowerCase() !== "ok") {
      throw new SmsSendError(`Termii: ${detail || json.code}`, isPermanentRefusal(400, detail));
    }
    return { providerMessageId: typeof json.message_id === "string" ? json.message_id : null };
  }
}

/** Development transport: prints a masked number and the kind of message, never the text or the number. */
export class LogSmsProvider implements SmsProvider {
  async send(m: OutgoingSms): Promise<SmsSendResult> {
    console.log(`[sms:log] to=${m.to.slice(0, 4)}***${m.to.slice(-2)} channel=${m.channel} chars=${m.text.length}`);
    return { providerMessageId: null };
  }
}

/**
 * Returns null when texting is not configured; callers then leave the outbox alone, so texts wait instead of being marked sent
 * without going anywhere. SMS_TRANSPORT=log opts in to the log transport. TERMII_API_KEY and TERMII_SENDER_ID are both needed.
 */
export function createSmsProvider(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): SmsProvider | null {
  if (env.SMS_TRANSPORT === "log") return new LogSmsProvider();
  if (env.TERMII_API_KEY && env.TERMII_SENDER_ID) {
    return new TermiiProvider(
      env.TERMII_API_KEY,
      env.TERMII_SENDER_ID,
      env.TERMII_BASE_URL || undefined,
      env.TERMII_WHATSAPP_FROM || null,
      fetchFn,
    );
  }
  return null;
}
