import { z } from "zod";
import { parseChargeForm, parsePaymentForm } from "@/lib/staff/folio";
import { checkStaffNote } from "@/lib/staff/reservation-note";
import {
  FOLIO_FIELDS,
  MAX_FOLIO_FIELD,
  MAX_NOTE_FIELD,
  QUEUE_ACTIONS,
  folioReplayItemSchema,
  hasNote,
  isFolioAction,
  isNoteAction,
  noteLimit,
  noteReplayItemSchema,
  replayItemSchema,
  type FolioAction,
  type QueueAction,
  REASON_TEXT,
  type ReplayReason,
  type ReplayResult,
} from "./replay";

/** A change made while offline, waiting to be sent. Pure rules only; the browser storage is in queue-store.ts. */
export const MAX_QUEUE = 100;
export const MAX_ATTEMPTS = 5;

const waiting = { label: z.string().max(120), queuedAt: z.string().max(40), attempts: z.number().int().min(0).max(100) };
/**
 * A housekeeping or repair step, a folio change, or a booking note. Told apart by `action`, so what an older version stored
 * (housekeeping only) still reads.
 */
export const queuedItemSchema = z.union([
  replayItemSchema.extend(waiting),
  folioReplayItemSchema.extend(waiting),
  noteReplayItemSchema.extend(waiting),
]);
export type QueuedItem = z.infer<typeof queuedItemSchema>;
export type HousekeepingQueuedItem = Extract<QueuedItem, { taskId: string }>;
export type FolioQueuedItem = Extract<QueuedItem, { fields: Record<string, string> }>;
export type NoteQueuedItem = Extract<QueuedItem, { action: "note_set" }>;
export const isFolioItem = (i: QueuedItem): i is FolioQueuedItem => isFolioAction(i.action);
export const isNoteItem = (i: QueuedItem): i is NoteQueuedItem => isNoteAction(i.action);
export const isHousekeepingItem = (i: QueuedItem): i is HousekeepingQueuedItem => !isFolioItem(i) && !isNoteItem(i);
/**
 * A change the database refused. `kept` is the text the person typed (a booking note), which is shown to them so that a refused
 * note is never lost; `userId` says whose it is, because it is saved on this computer until dismissed.
 */
export type Problem = { id: string; label: string; reason: ReplayReason; kept?: string; userId?: string };

const isAction = (v: unknown): v is QueueAction => (QUEUE_ACTIONS as readonly unknown[]).includes(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds the waiting item from a submitted form, or null when the form is not one that may wait. Fields are the form's own. */
export function buildItem(input: {
  action: string | undefined;
  fields: Record<string, string>;
  label: string | undefined;
  userId: string;
  id: string;
  now: Date;
}): QueuedItem | null {
  if (isFolioAction(input.action)) return buildFolioItem({ ...input, action: input.action });
  if (isNoteAction(input.action)) return buildNoteItem(input);
  if (!isAction(input.action)) return null;
  // A repair form names its target requestId, a housekeeping form taskId; either way it is the one id the change is for.
  const taskId = (input.action.startsWith("maint_") ? input.fields.requestId : input.fields.taskId) ?? "";
  if (!UUID.test(taskId) || !UUID.test(input.userId)) return null;
  const note = hasNote(input.action) ? (input.fields.note ?? "").trim().slice(0, noteLimit(input.action)) : "";
  return {
    id: input.id,
    action: input.action,
    taskId,
    userId: input.userId,
    ...(note ? { note } : {}),
    label: (input.label ?? "Task").slice(0, 120),
    queuedAt: input.now.toISOString(),
    attempts: 0,
  };
}

/**
 * A folio change from its form. The fields are checked with the same parsers as the screen, so a form the database would refuse
 * for its shape is refused here, while the person is still looking at it, not later from the banner. The item's id is made here
 * and is the idempotency key: one per change, the same on every retry, never the key printed in the page.
 */
function buildFolioItem(input: {
  action: FolioAction;
  fields: Record<string, string>;
  label: string | undefined;
  userId: string;
  id: string;
  now: Date;
}): QueuedItem | null {
  const reservationId = input.fields.reservationId ?? "";
  if (!UUID.test(reservationId) || !UUID.test(input.userId) || !UUID.test(input.id)) return null;
  const fields: Record<string, string> = {};
  for (const name of FOLIO_FIELDS[input.action]) {
    const value = input.fields[name];
    if (typeof value === "string" && value !== "") fields[name] = value.slice(0, MAX_FOLIO_FIELD);
  }
  const parsed = input.action === "folio_charge" ? parseChargeForm(fields) : parsePaymentForm(fields);
  if (!parsed.ok) return null;
  // The banner lists waiting changes by this words, so say what it is: what was charged, or how much was taken.
  const what =
    input.action === "folio_charge"
      ? `Extra: ${(fields.description ?? "").trim()}${fields.quantity && fields.quantity.trim() !== "1" ? ` × ${fields.quantity.trim()}` : ""}`
      : `Payment for extras: ${(fields.amount ?? "").trim()}`;
  const fallback = what.slice(0, 120);
  return {
    id: input.id,
    action: input.action,
    userId: input.userId,
    reservationId,
    fields,
    label: (input.label ?? fallback).slice(0, 120),
    queuedAt: input.now.toISOString(),
    attempts: 0,
  };
}

/**
 * A booking note from its form: the text typed and the text it replaced (the page's own copy, in a hidden field). A note too long for
 * the database is refused here, while the person is still looking at the form. Everything is kept as typed; the database cleans it.
 */
function buildNoteItem(input: {
  fields: Record<string, string>;
  label: string | undefined;
  userId: string;
  id: string;
  now: Date;
}): QueuedItem | null {
  const reservationId = input.fields.reservationId ?? "";
  if (!UUID.test(reservationId) || !UUID.test(input.userId) || !UUID.test(input.id)) return null;
  const note = input.fields.note ?? "";
  const expected = input.fields.expected ?? "";
  if (checkStaffNote(note) || note.length > MAX_NOTE_FIELD || expected.length > MAX_NOTE_FIELD) return null;
  return {
    id: input.id,
    action: "note_set",
    userId: input.userId,
    reservationId,
    note,
    expected,
    label: (input.label ?? "Booking note").slice(0, 120),
    queuedAt: input.now.toISOString(),
    attempts: 0,
  };
}

/**
 * The time to send as "when this was made": the moment it was queued, as an ISO string with a zone, or undefined when the stored
 * text is not one (the database then uses the arrival time). Never later than `now`, so a clock that was ahead cannot send the future.
 */
export function madeAtOf(queuedAt: string, now: Date = new Date()): string | undefined {
  const ms = Date.parse(queuedAt);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(Math.min(ms, now.getTime())).toISOString();
}

/**
 * Adds an item unless the queue is full or the same change is already waiting. For housekeeping that is the same step on the same
 * task. A folio change has no such identity (two identical minibar charges are two charges), so only the very same item id is a
 * duplicate; a form is locked while its change waits, which is what stops a double tap.
 */
export function addItem(queue: QueuedItem[], item: QueuedItem): { queue: QueuedItem[]; added: boolean } {
  if (queue.length >= MAX_QUEUE) return { queue, added: false };
  if (queue.some((q) => q.id === item.id)) return { queue, added: false };
  if (isNoteItem(item)) {
    // A newer note on the same booking replaces the one still waiting, but keeps what that one expected to find: that is the text
    // the database holds, however many times the person edits from a copy of the page that has not been refreshed.
    const earlier = queue.find(
      (q): q is NoteQueuedItem => isNoteItem(q) && q.reservationId === item.reservationId && q.userId === item.userId,
    );
    if (earlier) return { queue: [...queue.filter((q) => q !== earlier), { ...item, expected: earlier.expected }], added: true };
  }
  if (
    isHousekeepingItem(item) &&
    queue.some((q) => isHousekeepingItem(q) && q.taskId === item.taskId && q.action === item.action && q.userId === item.userId)
  )
    return { queue, added: false };
  return { queue: [...queue, item], added: true };
}

/** What the person is told about a change that could not be applied. A refused note brings its text along, so it is not lost. */
function problemOf(item: QueuedItem, reason: ReplayReason): Problem {
  const base = { id: item.id, label: item.label, reason };
  return isNoteItem(item) && item.note.trim() !== "" ? { ...base, kept: item.note, userId: item.userId } : base;
}

const keptProblemSchema = z.object({
  id: z.string().max(64),
  label: z.string().max(120),
  reason: z.enum(Object.keys(REASON_TEXT) as [ReplayReason, ...ReplayReason[]]),
  kept: z.string().max(MAX_NOTE_FIELD),
  userId: z.string().max(64),
});

/** Refused notes are kept on this computer until dismissed, so a reload does not lose what was typed. Only those that carry text. */
export function keptOnly(problems: Problem[]): Problem[] {
  return problems.filter((p) => typeof p.kept === "string" && p.kept !== "" && typeof p.userId === "string");
}

/** Reads the kept notes of this person, trusting none of it. */
export function parseKept(raw: string | null, userId: string): Problem[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: Problem[] = [];
    for (const entry of data.slice(0, MAX_QUEUE)) {
      const parsed = keptProblemSchema.safeParse(entry);
      if (parsed.success && parsed.data.userId === userId) out.push(parsed.data);
    }
    return out;
  } catch {
    return [];
  }
}

/** Applies the server's answers: finished items leave, refused ones become problems, retries count an attempt. */
export function applyResults(queue: QueuedItem[], results: ReplayResult[]): { queue: QueuedItem[]; problems: Problem[]; applied: number } {
  const byId = new Map(results.map((r) => [r.id, r]));
  const next: QueuedItem[] = [];
  const problems: Problem[] = [];
  let applied = 0;
  for (const item of queue) {
    const r = byId.get(item.id);
    if (!r) next.push(item);
    else if (r.status === "done") applied++;
    else if (r.status === "already") continue;
    else if (r.status === "rejected") problems.push(problemOf(item, r.reason ?? "error"));
    else if (item.attempts + 1 >= MAX_ATTEMPTS) problems.push(problemOf(item, "error"));
    else next.push({ ...item, attempts: item.attempts + 1 });
  }
  return { queue: next, problems, applied };
}

/** Items saved by someone else on this computer can never be sent as the person now signed in. */
export function keepOnlyUser(queue: QueuedItem[], userId: string): QueuedItem[] {
  return queue.filter((q) => q.userId === userId);
}

/** Reads what was stored, trusting none of it: a broken or hand-edited entry is dropped, never sent. */
export function parseStored(raw: string | null): QueuedItem[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: QueuedItem[] = [];
    for (const entry of data.slice(0, MAX_QUEUE)) {
      const parsed = queuedItemSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  } catch {
    return [];
  }
}
