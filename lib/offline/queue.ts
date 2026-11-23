import { z } from "zod";
import { MAX_NOTE, QUEUE_ACTIONS, replayItemSchema, type QueueAction, type ReplayReason, type ReplayResult } from "./replay";

/** A change made while offline, waiting to be sent. Pure rules only; the browser storage is in queue-store.ts. */
export const MAX_QUEUE = 100;
export const MAX_ATTEMPTS = 5;

export const queuedItemSchema = replayItemSchema.extend({
  label: z.string().max(120),
  queuedAt: z.string().max(40),
  attempts: z.number().int().min(0).max(100),
});
export type QueuedItem = z.infer<typeof queuedItemSchema>;
export type Problem = { id: string; label: string; reason: ReplayReason };

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
  if (!isAction(input.action)) return null;
  const taskId = input.fields.taskId ?? "";
  if (!UUID.test(taskId) || !UUID.test(input.userId)) return null;
  const note = input.action === "complete" ? (input.fields.note ?? "").trim().slice(0, MAX_NOTE) : "";
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

/** Adds an item unless the same step on the same task is already waiting, or the queue is full. */
export function addItem(queue: QueuedItem[], item: QueuedItem): { queue: QueuedItem[]; added: boolean } {
  if (queue.length >= MAX_QUEUE) return { queue, added: false };
  if (queue.some((q) => q.taskId === item.taskId && q.action === item.action && q.userId === item.userId)) return { queue, added: false };
  return { queue: [...queue, item], added: true };
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
    else if (r.status === "rejected") problems.push({ id: item.id, label: item.label, reason: r.reason ?? "error" });
    else if (item.attempts + 1 >= MAX_ATTEMPTS) problems.push({ id: item.id, label: item.label, reason: "error" });
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
