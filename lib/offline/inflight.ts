import { z } from "zod";
import { isFolioAction } from "./replay";

/**
 * The change a person has just sent from a form that is allowed to wait (housekeeping, repairs, folio, booking note). If the
 * connection fails while it is being sent, the page that comes back is the error page and what was typed is gone. So the values are
 * kept in this tab (sessionStorage, which ends with the tab) for a few seconds; the error page turns them into a waiting change.
 *
 * Why that is safe even when the first send did reach the server: every one of these changes can be sent twice. Housekeeping and
 * repair steps return the task unchanged when it is already done; a folio change carries an idempotency key and a repeat gets the
 * first answer; a booking note is applied only while the note still reads what the person saw, and a note that already reads as sent
 * is a no-op. For a folio change the form's own key is reused here, so the repeat is recognised as the same change.
 */
export const INFLIGHT_KEY = "hms-inflight-v1";
/** Longer than a slow send, shorter than a person doing something else: a failure much later is not this change's. */
export const INFLIGHT_MAX_AGE_MS = 20_000;
const MAX_FIELDS = 20;
const MAX_FIELD_LENGTH = 4000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const inflightSchema = z.object({
  action: z.string().max(40),
  fields: z.record(z.string().max(40), z.string().max(MAX_FIELD_LENGTH)).refine((f) => Object.keys(f).length <= MAX_FIELDS),
  label: z.string().max(120).optional(),
  userId: z.guid(),
  at: z.iso.datetime({ offset: true }),
});
export type Inflight = z.infer<typeof inflightSchema>;

/** What to remember of a submitted form: its own text fields, capped. Files and anything that is not text are left out. */
export function makeInflight(input: {
  action: string;
  fields: Record<string, string>;
  label?: string;
  userId: string;
  now: Date;
}): Inflight {
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.fields).slice(0, MAX_FIELDS)) {
    if (typeof value === "string") fields[name.slice(0, 40)] = value.slice(0, MAX_FIELD_LENGTH);
  }
  return {
    action: input.action.slice(0, 40),
    fields,
    ...(input.label ? { label: input.label.slice(0, 120) } : {}),
    userId: input.userId,
    at: input.now.toISOString(),
  };
}

/** Reads what was stored, trusting none of it. */
export function parseInflight(raw: string | null): Inflight | null {
  if (!raw) return null;
  try {
    const parsed = inflightSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Only a change sent a moment ago can be the one that just failed. */
export function isRecent(at: string, now: Date): boolean {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && now.getTime() - ms >= 0 && now.getTime() - ms <= INFLIGHT_MAX_AGE_MS;
}

/**
 * The id the waiting change gets. A folio change keeps the key the form carried, so if the first send did get through the server
 * recognises the repeat; everything else needs no key (see above), so it gets a fresh id.
 */
export function rescueId(inflight: Inflight, fresh: string): string {
  if (isFolioAction(inflight.action)) {
    const key = inflight.fields.idempotencyKey ?? "";
    if (UUID.test(key)) return key;
  }
  return fresh;
}
