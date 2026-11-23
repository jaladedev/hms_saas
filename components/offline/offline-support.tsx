"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clearOfflineData, registerOffline, warmSavedPages } from "@/lib/offline/client";
import { setOffline, useOffline } from "@/lib/offline/connection";
import { REASON_TEXT } from "@/lib/offline/replay";
import { dismissProblem, enqueueFromForm, flushQueue, followOtherTabs, initQueue, useQueue } from "@/lib/offline/queue-store";
import { bannerState, savedAtLabel } from "@/lib/offline/saved-pages";

declare global {
  interface Window {
    /** Set by public/sw.js when it answers from a saved copy. */
    __HMS_CACHED_AT?: string;
  }
}

const PROBE_EVERY_MS = 20_000;
const PROBE_TIMEOUT_MS = 4_000;
/** A connection check this recent is trusted when a change is made, so a tap does not wait for another one. */
const FRESH_MS = 10_000;

/** One real request to the app. A 204 means the server is reachable; anything else, or no answer, means it is not. */
async function reachable(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/ping", { method: "HEAD", cache: "no-store", signal: ctl.signal });
    return res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A form whose change is waiting to be sent: its controls are locked and it says so, until the change leaves the queue. */
function markQueued(form: HTMLFormElement, id: string) {
  form.dataset.queuedId = id;
  form.querySelectorAll<HTMLElement>("button, input, select, textarea").forEach((el) => el.setAttribute("disabled", ""));
  const tag = document.createElement("span");
  tag.className = "text-sm text-muted";
  tag.dataset.queuedTag = "";
  tag.textContent = "Waiting to send";
  form.appendChild(tag);
}

function unmarkQueued(form: HTMLFormElement) {
  delete form.dataset.queuedId;
  form.querySelectorAll<HTMLElement>("[disabled]").forEach((el) => el.removeAttribute("disabled"));
  form.querySelectorAll("[data-queued-tag]").forEach((el) => el.remove());
}

/**
 * Staff pages only. Registers the service worker, keeps the front desk pages saved, watches the connection and says
 * plainly when the person is offline or looking at a saved copy. While offline, a form that may wait (housekeeping: take,
 * start, done) is saved on this computer and sent when the connection is back; every other form is stopped, because a change
 * that cannot reach the server would only fail with a confusing error and look as if it had been saved.
 */
export function OfflineSupport({ userId }: { userId: string }) {
  const router = useRouter();
  const offline = useOffline();
  const queue = useQueue();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const offlineRef = useRef(false);
  const lastOkRef = useRef(0);
  const bypass = useRef<WeakSet<HTMLFormElement>>(new WeakSet());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    offlineRef.current = offline;
  }, [offline]);

  useEffect(() => {
    initQueue(userId);
    const stopFollowing = followOtherTabs(userId);
    setSavedAt(window.__HMS_CACHED_AT ?? null);
    void registerOffline();

    let stopped = false;
    function say(text: string) {
      setNotice(text);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 8_000);
    }
    async function send() {
      const applied = await flushQueue(userId);
      if (applied > 0 && !stopped) router.refresh();
    }
    async function check() {
      const ok = await reachable();
      if (stopped) return;
      setOffline(!ok);
      if (ok) {
        lastOkRef.current = Date.now();
        void warmSavedPages();
        void send();
      }
    }
    const firstCheck = setTimeout(() => void check(), 3_000);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, PROBE_EVERY_MS);
    const onChange = () => void check();
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    window.addEventListener("focus", onChange);

    function wait(form: HTMLFormElement) {
      const id = enqueueFromForm(form, userId);
      if (id) {
        markQueued(form, id);
        say("Saved on this computer. It will be sent when the connection is back.");
      } else {
        say("That could not be saved for later. Try again when the connection is back.");
      }
    }

    // Capture on window so this runs before React sees the submit.
    const onSubmit = (e: Event) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || form.hasAttribute("data-allow-offline") || bypass.current.has(form)) return;
      const canWait = form.dataset.queue !== undefined;
      if (offlineRef.current) {
        e.preventDefault();
        e.stopPropagation();
        if (canWait) wait(form);
        else say("That was not sent: you are offline. Try again when the connection is back.");
        return;
      }
      // Online as of the last check, but that check may be old: for a change that can wait, confirm first, then send or save.
      if (canWait && Date.now() - lastOkRef.current > FRESH_MS) {
        e.preventDefault();
        e.stopPropagation();
        const submitter = (e as SubmitEvent).submitter;
        void reachable().then((ok) => {
          if (stopped) return;
          if (ok) {
            lastOkRef.current = Date.now();
            bypass.current.add(form);
            form.requestSubmit(submitter instanceof HTMLElement ? (submitter as HTMLButtonElement) : undefined);
          } else {
            setOffline(true);
            wait(form);
          }
        });
      }
    };
    window.addEventListener("submit", onSubmit, true);

    return () => {
      stopped = true;
      stopFollowing();
      clearTimeout(firstCheck);
      clearInterval(interval);
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("submit", onSubmit, true);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [userId, router]);

  // A change that has left the queue (sent, or refused) frees its form again.
  useEffect(() => {
    const waiting = new Set(queue.items.map((i) => i.id));
    document.querySelectorAll<HTMLFormElement>("form[data-queued-id]").forEach((form) => {
      if (!waiting.has(form.dataset.queuedId ?? "")) unmarkQueued(form);
    });
  }, [queue.items]);

  const state = bannerState(offline, savedAt);
  const waiting = queue.items.length;
  if (state === "none" && !notice && waiting === 0 && queue.problems.length === 0) return null;
  const when = savedAt ? savedAtLabel(savedAt, new Date()) : "";

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-lg border border-pending bg-pending/10 px-4 py-3 text-sm text-ink print:hidden"
    >
      {state === "offline-saved" && (
        <p>
          <strong>You are offline.</strong> This is a copy saved at {when}. It may be out of date.
        </p>
      )}
      {state === "offline-live" && (
        <p>
          <strong>You are offline.</strong> What you see may be out of date.
        </p>
      )}
      {state === "slow-saved" && (
        <p>
          <strong>Slow connection.</strong> Showing a copy saved at {when}.{" "}
          <button type="button" onClick={() => window.location.reload()} className="underline underline-offset-2">
            Load the latest
          </button>
        </p>
      )}
      {waiting > 0 && (
        <div className={state === "none" ? "" : "mt-2"}>
          <p>
            <strong>
              {waiting} {waiting === 1 ? "change is" : "changes are"} waiting to be sent.
            </strong>{" "}
            {queue.signedOut ? (
              <>
                Your session ended.{" "}
                <Link href="/login?next=/app/housekeeping" className="underline underline-offset-2">
                  Sign in again
                </Link>{" "}
                to send {waiting === 1 ? "it" : "them"}.
              </>
            ) : queue.sending ? (
              "Sending…"
            ) : offline ? (
              "They will be sent when the connection is back. Keep this window open."
            ) : (
              "Sending soon."
            )}
          </p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {queue.items.slice(0, 5).map((i) => (
              <li key={i.id}>{i.label}</li>
            ))}
            {waiting > 5 && <li>and {waiting - 5} more</li>}
          </ul>
        </div>
      )}
      {queue.problems.map((p) => (
        <p key={p.id} className="mt-2 text-critical">
          <strong>{p.label}</strong> was not applied: {REASON_TEXT[p.reason]}.{" "}
          <button type="button" onClick={() => dismissProblem(p.id)} className="underline underline-offset-2">
            Dismiss
          </button>
        </p>
      ))}
      {notice && <p className={state === "none" && waiting === 0 && queue.problems.length === 0 ? "" : "mt-2"}>{notice}</p>}
    </div>
  );
}

/** Renders nothing. On the sign-in page it removes saved pages left on this computer by whoever used it before. */
export function ClearOfflineData() {
  useEffect(() => {
    void clearOfflineData();
  }, []);
  return null;
}
