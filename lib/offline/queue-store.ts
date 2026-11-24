"use client";

import { useSyncExternalStore } from "react";
import {
  addItem,
  applyResults,
  buildItem,
  isFolioItem,
  isHousekeepingItem,
  isNoteItem,
  keepOnlyUser,
  keptOnly,
  madeAtOf,
  parseKept,
  parseStored,
  type Problem,
  type QueuedItem,
} from "./queue";
import { MAX_REPLAY_ITEMS, folioReplayBodySchema, noteReplayBodySchema, replayBodySchema, type ReplayResult } from "./replay";

const KEY = "hms-offline-queue-v1";
const HOUSEKEEPING_ENDPOINT = "/api/staff/housekeeping/replay";
const FOLIO_ENDPOINT = "/api/staff/folio/replay";
const NOTE_ENDPOINT = "/api/staff/reservation-note/replay";
/** Refused booking notes, kept until dismissed so that a reload does not lose what the person typed. */
const KEPT_KEY = "hms-offline-kept-v1";

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

function persistKept(problems: Problem[]) {
  try {
    const kept = keptOnly(problems);
    if (kept.length) localStorage.setItem(KEPT_KEY, JSON.stringify(kept));
    else localStorage.removeItem(KEPT_KEY);
  } catch {
    // Storage full or blocked: the text is still shown in the banner for this visit.
  }
}

/** Every kept note on this computer, of whoever's it is, so saving this person's never drops another's. */
function readKeptAll(): Problem[] {
  try {
    const raw = localStorage.getItem(KEPT_KEY);
    const data: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? (data as Problem[]) : [];
  } catch {
    return [];
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
  let kept: Problem[] = [];
  try {
    kept = parseKept(localStorage.getItem(KEPT_KEY), userId);
  } catch {
    // No storage: nothing was kept.
  }
  set({ items: mine, problems: kept });
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

/** What one endpoint is sent: the body for its items, as the route's own schema reads it. */
function housekeepingBody(items: QueuedItem[]) {
  return replayBodySchema.parse({
    items: items.filter(isHousekeepingItem).map(({ id, action, taskId, note, userId, queuedAt }) => ({
      id,
      action,
      taskId,
      note,
      userId,
      madeAt: madeAtOf(queuedAt),
    })),
  });
}
function noteBody(items: QueuedItem[]) {
  return noteReplayBodySchema.parse({
    items: items.filter(isNoteItem).map(({ id, action, userId, reservationId, note, expected, queuedAt }) => ({
      id,
      action,
      userId,
      reservationId,
      note,
      expected,
      madeAt: madeAtOf(queuedAt),
    })),
  });
}
function folioBody(items: QueuedItem[]) {
  return folioReplayBodySchema.parse({
    items: items.filter(isFolioItem).map(({ id, action, userId, reservationId, fields, queuedAt }) => ({
      id,
      action,
      userId,
      reservationId,
      fields,
      madeAt: madeAtOf(queuedAt),
    })),
  });
}

type Sent = { results: ReplayResult[] } | "signed_out" | "failed";

async function post(endpoint: string, body: unknown): Promise<Sent> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  // A redirect to the sign-in page, or a 401, means the session ended: keep everything and ask them to sign in.
  if (res.redirected || res.status === 401) return "signed_out";
  if (!res.ok) return "failed";
  const json = (await res.json()) as { results?: ReplayResult[] };
  return { results: json.results ?? [] };
}

/**
 * Sends what is waiting: housekeeping and repair steps to their route, folio changes to theirs, then booking notes to theirs, each in
 * the order they were made (the kinds do not depend on each other). Resolves to how many changes were applied; one send runs at a time. A group that fails
 * leaves its items queued and the other group is still tried; a session that ended stops everything and keeps it all.
 */
export function flushQueue(userId: string): Promise<number> {
  if (inFlight) return inFlight;
  const items = keepOnlyUser(read(), userId);
  if (items.length === 0) return Promise.resolve(0);
  set({ sending: true, signedOut: false });
  inFlight = (async () => {
    let applied = 0;
    try {
      const groups: { endpoint: string; items: QueuedItem[]; body: (i: QueuedItem[]) => unknown }[] = [
        { endpoint: HOUSEKEEPING_ENDPOINT, items: items.filter(isHousekeepingItem).slice(0, MAX_REPLAY_ITEMS), body: housekeepingBody },
        { endpoint: FOLIO_ENDPOINT, items: items.filter(isFolioItem).slice(0, MAX_REPLAY_ITEMS), body: folioBody },
        { endpoint: NOTE_ENDPOINT, items: items.filter(isNoteItem).slice(0, MAX_REPLAY_ITEMS), body: noteBody },
      ];
      for (const group of groups) {
        if (group.items.length === 0) continue;
        let sent: Sent;
        try {
          sent = await post(group.endpoint, group.body(group.items));
        } catch {
          continue; // The connection dropped again: this group stays queued.
        }
        if (sent === "signed_out") {
          set({ signedOut: true });
          return applied;
        }
        if (sent === "failed") continue;
        const result = applyResults(read(), sent.results);
        persist(result.queue);
        const problems = [...state.problems, ...result.problems];
        // A refused note brings its text along; save it before anything else can happen, next to other people's kept notes.
        if (result.problems.some((p) => p.kept !== undefined)) {
          persistKept([...readKeptAll().filter((k) => k.userId !== userId), ...problems]);
        }
        set({ items: keepOnlyUser(result.queue, userId), problems });
        applied += result.applied;
      }
      return applied;
    } finally {
      inFlight = null;
      set({ sending: false });
    }
  })();
  return inFlight;
}

export function dismissProblem(id: string) {
  set({ problems: state.problems.filter((p) => p.id !== id) });
  persistKept(readKeptAll().filter((k) => k.id !== id));
}

/** Forgets everything waiting. Only for sign-out, after the person has been told what would be lost. */
export function discardQueue() {
  persist([]);
  persistKept([]);
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
