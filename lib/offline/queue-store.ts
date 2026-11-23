"use client";

import { useSyncExternalStore } from "react";
import { addItem, applyResults, buildItem, keepOnlyUser, madeAtOf, parseStored, type Problem, type QueuedItem } from "./queue";
import { replayBodySchema, type ReplayResult } from "./replay";

const KEY = "hms-offline-queue-v1";
const ENDPOINT = "/api/staff/housekeeping/replay";

export type QueueState = { items: QueuedItem[]; problems: Problem[]; sending: boolean; signedOut: boolean };
const EMPTY: QueueState = { items: [], problems: [], sending: false, signedOut: false };

let state: QueueState = EMPTY;
const listeners = new Set<() => void>();
let inFlight: Promise<number> | null = null;

function set(next: Partial<QueueState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function persist(items: QueuedItem[]) {
  try {
    if (items.length) localStorage.setItem(KEY, JSON.stringify(items));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage full or blocked: the change stays in memory for this visit only.
  }
}

function read(): QueuedItem[] {
  try {
    return parseStored(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

/** Loads what is waiting for this person; anything saved by someone else on this computer is dropped. */
export function initQueue(userId: string) {
  const mine = keepOnlyUser(read(), userId);
  persist(mine);
  set({ items: mine });
}

/** Another tab changed the queue: follow it, so two tabs never send the same change twice. */
export function followOtherTabs(userId: string): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) set({ items: keepOnlyUser(read(), userId) });
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** Puts a submitted form's change in the queue. Returns the waiting item's id, or null when the form may not wait or the queue is full. */
export function enqueueFromForm(form: HTMLFormElement, userId: string): string | null {
  const fields: Record<string, string> = {};
  new FormData(form).forEach((v, k) => {
    if (typeof v === "string") fields[k] = v;
  });
  const item = buildItem({
    action: form.dataset.queue,
    fields,
    label: form.dataset.queueLabel,
    userId,
    id: crypto.randomUUID(),
    now: new Date(),
  });
  if (!item) return null;
  const { queue, added } = addItem(read(), item);
  if (!added) return null;
  persist(queue);
  set({ items: keepOnlyUser(queue, userId) });
  return item.id;
}

/** Sends what is waiting. Resolves to how many changes were applied; one send runs at a time. */
export function flushQueue(userId: string): Promise<number> {
  if (inFlight) return inFlight;
  const items = keepOnlyUser(read(), userId);
  if (items.length === 0) return Promise.resolve(0);
  set({ sending: true, signedOut: false });
  inFlight = (async () => {
    try {
      const body = replayBodySchema.parse({
        items: items.slice(0, 50).map(({ id, action, taskId, note, userId: u, queuedAt }) => ({
          id,
          action,
          taskId,
          note,
          userId: u,
          madeAt: madeAtOf(queuedAt),
        })),
      });
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
      });
      // A redirect to the sign-in page, or a 401, means the session ended: keep everything and ask them to sign in.
      if (res.redirected || res.status === 401) {
        set({ signedOut: true });
        return 0;
      }
      if (!res.ok) return 0;
      const json = (await res.json()) as { results?: ReplayResult[] };
      const applied = applyResults(read(), json.results ?? []);
      persist(applied.queue);
      set({ items: keepOnlyUser(applied.queue, userId), problems: [...state.problems, ...applied.problems] });
      return applied.applied;
    } catch {
      return 0; // The connection dropped again: everything stays queued.
    } finally {
      inFlight = null;
      set({ sending: false });
    }
  })();
  return inFlight;
}

export function dismissProblem(id: string) {
  set({ problems: state.problems.filter((p) => p.id !== id) });
}

/** Forgets everything waiting. Only for sign-out, after the person has been told what would be lost. */
export function discardQueue() {
  persist([]);
  set({ items: [], problems: [] });
}

export function pendingCount(): number {
  return state.items.length;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useQueue(): QueueState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}
