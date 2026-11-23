import { z } from "zod";

/**
 * Housekeeping actions that can wait for the connection (the first queued actions; see TODO.md "Unreliable internet").
 * They are safe to send twice: the database functions return the task unchanged when it is already claimed by you, already
 * started, or already done (migration 023). Shared by the page code that queues them and the route that replays them.
 */
export const QUEUE_ACTIONS = ["claim", "start", "complete"] as const;
export type QueueAction = (typeof QUEUE_ACTIONS)[number];
export const MAX_REPLAY_ITEMS = 50;
export const MAX_NOTE = 500;

const uuid = z.guid();

export const replayItemSchema = z.object({
  id: uuid,
  action: z.enum(QUEUE_ACTIONS),
  taskId: uuid,
  note: z.string().max(MAX_NOTE).optional(),
  userId: uuid,
});
export const replayBodySchema = z.object({ items: z.array(replayItemSchema).max(MAX_REPLAY_ITEMS) });
export type ReplayItem = z.infer<typeof replayItemSchema>;

/** done: applied now. already: it had been applied (or the task moved past it), nothing to do. rejected: will never work. retry: try later. */
export type ReplayStatus = "done" | "already" | "rejected" | "retry";
export type ReplayReason = "taken" | "cancelled" | "missing" | "forbidden" | "other_user" | "error";
export type ReplayResult = { id: string; status: ReplayStatus; reason?: ReplayReason };

/** What the person is told when a waiting change could not be applied. Fixed wording: database text never reaches the browser. */
export const REASON_TEXT: Record<ReplayReason, string> = {
  taken: "someone else had already taken the task",
  cancelled: "the task was cancelled",
  missing: "the task no longer exists",
  forbidden: "you no longer have permission",
  other_user: "it was saved by a different person on this computer",
  error: "it could not be applied",
};

/** Turns a database refusal into what to do with the waiting change. Anything unrecognised is retried, a few times. */
export function classifyReplayError(_action: QueueAction, message: string): Pick<ReplayResult, "status" | "reason"> {
  if (/NOT_FOUND/.test(message)) return { status: "rejected", reason: "missing" };
  if (/FORBIDDEN: assigned to someone else/.test(message)) return { status: "rejected", reason: "taken" };
  if (/INVALID_STATE: task cancelled/.test(message)) return { status: "rejected", reason: "cancelled" };
  // Start or claim on a task that is already finished: the work is past that step, so there is nothing left to do.
  if (/INVALID_STATE: task done/.test(message)) return { status: "already" };
  if (/INVALID_STATE/.test(message)) return { status: "rejected", reason: "error" };
  if (/FORBIDDEN/.test(message)) return { status: "rejected", reason: "forbidden" };
  if (/POLICY_VIOLATION/.test(message)) return { status: "rejected", reason: "error" };
  return { status: "retry" };
}
