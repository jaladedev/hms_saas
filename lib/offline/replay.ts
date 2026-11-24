import { z } from "zod";
import { MAX_STAFF_NOTE } from "@/lib/staff/reservation-note";

/**
 * Staff actions that can wait for the connection (see TODO.md "Unreliable internet"): taking, starting and finishing a housekeeping
 * task (`claim`, `start`, `complete`) and a repair (`maint_claim`, `maint_start`, `maint_resolve`). They are safe to send twice: the
 * database functions return the task or request unchanged when it is already claimed by you, already started, or already done
 * (migrations 023 and 026). Shared by the page code that queues them and the route that replays them.
 */
export const QUEUE_ACTIONS = ["claim", "start", "complete", "maint_claim", "maint_start", "maint_resolve"] as const;
export type QueueAction = (typeof QUEUE_ACTIONS)[number];
export const MAX_REPLAY_ITEMS = 50;
/** The longest note the database accepts: 500 characters on a housekeeping task, 1000 on a repair. */
export const MAX_NOTE = 500;
export const MAX_NOTE_MAINT = 1000;
export const noteLimit = (action: QueueAction): number => (action === "maint_resolve" ? MAX_NOTE_MAINT : MAX_NOTE);
/** Which actions carry a note. */
export const hasNote = (action: QueueAction): boolean => action === "complete" || action === "maint_resolve";

const uuid = z.guid();

export const replayItemSchema = z
  .object({
    id: uuid,
    action: z.enum(QUEUE_ACTIONS),
    /** The housekeeping task, or the repair request, the change is for. */
    taskId: uuid,
    note: z.string().max(MAX_NOTE_MAINT).optional(),
    userId: uuid,
    /** When the person made the change (the queue's `queuedAt`). The database keeps it inside its own bounds (migration 185). */
    madeAt: z.iso.datetime({ offset: true }).optional(),
  })
  // The limit depends on the action: 500 characters on a housekeeping note, 1000 on a repair, as in the database.
  .refine((i) => (i.note ?? "").length <= noteLimit(i.action), { path: ["note"], message: "note too long" });
export const replayBodySchema = z.object({ items: z.array(replayItemSchema).max(MAX_REPLAY_ITEMS) });
export type ReplayItem = z.infer<typeof replayItemSchema>;

/** done: applied now. already: it had been applied (or the task moved past it), nothing to do. rejected: will never work. retry: try later. */
export type ReplayStatus = "done" | "already" | "rejected" | "retry";
export type ReplayReason =
  | "taken"
  | "cancelled"
  | "missing"
  | "forbidden"
  | "other_user"
  | "error"
  | "not_open"
  | "overpay"
  | "invalid"
  | "no_access"
  | "changed";
export type ReplayResult = { id: string; status: ReplayStatus; reason?: ReplayReason };

/** What the person is told when a waiting change could not be applied. Fixed wording: database text never reaches the browser. */
export const REASON_TEXT: Record<ReplayReason, string> = {
  taken: "someone else had already taken the task",
  cancelled: "the task was cancelled",
  missing: "the task no longer exists",
  forbidden: "you no longer have permission",
  other_user: "it was saved by a different person on this computer",
  error: "it could not be applied",
  not_open: "the booking is no longer open for extras",
  overpay: "it was more than is still owed for extras",
  invalid: "the details were not accepted",
  no_access: "the booking could not be found, or you no longer have access to it",
  changed: "someone else changed the note first",
};

/** Turns a database refusal into what to do with the waiting change. Anything unrecognised is retried, a few times. */
export function classifyReplayError(_action: QueueAction, message: string): Pick<ReplayResult, "status" | "reason"> {
  if (/NOT_FOUND/.test(message)) return { status: "rejected", reason: "missing" };
  if (/FORBIDDEN: assigned to someone else/.test(message)) return { status: "rejected", reason: "taken" };
  if (/INVALID_STATE: (task|request) cancelled/.test(message)) return { status: "rejected", reason: "cancelled" };
  // Start or claim on a task or repair that is already finished: the work is past that step, so there is nothing left to do.
  if (/INVALID_STATE: (task done|request resolved)/.test(message)) return { status: "already" };
  if (/INVALID_STATE/.test(message)) return { status: "rejected", reason: "error" };
  if (/FORBIDDEN/.test(message)) return { status: "rejected", reason: "forbidden" };
  if (/POLICY_VIOLATION/.test(message)) return { status: "rejected", reason: "error" };
  return { status: "retry" };
}

/**
 * Changes to a checked-in booking's folio (extras) that can wait for the connection (offline step 2b). Both database functions
 * take an idempotency key and answer a repeat with the first answer, so sending one twice records it once. The key is made when
 * the change is queued, never read from the page: a saved copy of a booking page carries one key in its markup, and two changes
 * made from that copy must not share it.
 *
 * What is NOT queued, on purpose: payments against the booking itself (they confirm a booking or settle a hold, which should not
 * be decided from an old copy of the page), voids and reversals, and anything that allocates a room.
 */
export const FOLIO_ACTIONS = ["folio_charge", "folio_payment"] as const;
export type FolioAction = (typeof FOLIO_ACTIONS)[number];
export const isFolioAction = (v: unknown): v is FolioAction => (FOLIO_ACTIONS as readonly unknown[]).includes(v);

/** The form fields each folio action may carry. Anything else on the form is left out of the queue. */
export const FOLIO_FIELDS: Record<FolioAction, readonly string[]> = {
  folio_charge: ["category", "description", "quantity", "amount", "date", "reservationRoomId"],
  folio_payment: ["amount", "method", "reference", "note"],
};
export const MAX_FOLIO_FIELD = 600;

export const folioReplayItemSchema = z.object({
  /** Also the idempotency key sent to the database, so it is unique for every change and the same on every retry. */
  id: uuid,
  action: z.enum(FOLIO_ACTIONS),
  userId: uuid,
  reservationId: uuid,
  /** The form's own values as typed. The route reads them with the same parsers as the screen, so the rules are in one place. */
  fields: z.record(z.string().max(40), z.string().max(MAX_FOLIO_FIELD)).refine((f) => Object.keys(f).length <= 12),
  madeAt: z.iso.datetime({ offset: true }).optional(),
});
export const folioReplayBodySchema = z.object({ items: z.array(folioReplayItemSchema).max(MAX_REPLAY_ITEMS) });
export type FolioReplayItem = z.infer<typeof folioReplayItemSchema>;

/**
 * Turns a database refusal of a folio change into what to do with the waiting change. Anything unrecognised is retried, a few
 * times; the idempotency key makes a retry safe even when the first attempt did get through.
 */
export function classifyFolioReplayError(message: string): Pick<ReplayResult, "status" | "reason"> {
  if (/OVERPAYMENT/.test(message)) return { status: "rejected", reason: "overpay" };
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return { status: "rejected", reason: "error" };
  if (/INVALID_STATE/.test(message)) return { status: "rejected", reason: "not_open" };
  if (/NOT_FOUND|FORBIDDEN/.test(message)) return { status: "rejected", reason: "no_access" };
  if (/POLICY_VIOLATION/.test(message)) return { status: "rejected", reason: "invalid" };
  return { status: "retry" };
}

/**
 * A staff note on a booking, saved while offline (migration 190). A note REPLACES the whole text, so it is not sent as a plain
 * overwrite: it carries the text it replaced (`expected`, what the page showed when the person started typing) and the database
 * applies it only if the booking's note is still that text. If someone else changed the note meanwhile it is refused and the app
 * keeps what the person typed. Sending it twice is harmless: a note already saved as this text is a no-op.
 */
export const NOTE_ACTIONS = ["note_set"] as const;
export type NoteAction = (typeof NOTE_ACTIONS)[number];
export const isNoteAction = (v: unknown): v is NoteAction => (NOTE_ACTIONS as readonly unknown[]).includes(v);
/** Room for stray spaces and line breaks around a note of the database's limit; the database counts the cleaned text. */
export const MAX_NOTE_FIELD = MAX_STAFF_NOTE + 200;

export const noteReplayItemSchema = z.object({
  id: uuid,
  action: z.literal("note_set"),
  userId: uuid,
  reservationId: uuid,
  /** The text to save; empty clears the note. */
  note: z.string().max(MAX_NOTE_FIELD),
  /** The text the person replaced, as the page showed it; empty when there was no note. */
  expected: z.string().max(MAX_NOTE_FIELD),
  madeAt: z.iso.datetime({ offset: true }).optional(),
});
export const noteReplayBodySchema = z.object({ items: z.array(noteReplayItemSchema).max(MAX_REPLAY_ITEMS) });
export type NoteReplayItem = z.infer<typeof noteReplayItemSchema>;

/** Turns a database refusal of a waiting note into what to do with it. Anything unrecognised is retried, a few times. */
export function classifyNoteReplayError(message: string): Pick<ReplayResult, "status" | "reason"> {
  if (/CONFLICT/.test(message)) return { status: "rejected", reason: "changed" };
  if (/POLICY_VIOLATION/.test(message)) return { status: "rejected", reason: "invalid" };
  if (/NOT_FOUND|FORBIDDEN/.test(message)) return { status: "rejected", reason: "no_access" };
  return { status: "retry" };
}
