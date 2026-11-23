"use client";

import { useEffect, useRef, useState } from "react";
import { clearOfflineData, registerOffline, warmSavedPages } from "@/lib/offline/client";
import { setOffline, useOffline } from "@/lib/offline/connection";
import { bannerState, savedAtLabel } from "@/lib/offline/saved-pages";

declare global {
  interface Window {
    /** Set by public/sw.js when it answers from a saved copy. */
    __HMS_CACHED_AT?: string;
  }
}

const PROBE_EVERY_MS = 20_000;
const PROBE_TIMEOUT_MS = 4_000;

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

/**
 * Staff pages only. Registers the service worker, keeps the front desk pages saved, watches the connection and says
 * plainly when the person is offline or looking at a saved copy. While offline it stops forms from being sent, because a
 * change that cannot reach the server would only fail with a confusing error and the person would think it was saved.
 */
export function OfflineSupport() {
  const offline = useOffline();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const offlineRef = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    offlineRef.current = offline;
  }, [offline]);

  useEffect(() => {
    setSavedAt(window.__HMS_CACHED_AT ?? null);
    void registerOffline();

    let stopped = false;
    async function check() {
      const ok = await reachable();
      if (stopped) return;
      setOffline(!ok);
      if (ok) void warmSavedPages();
    }
    const warmTimer = setTimeout(() => void check(), 3_000);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, PROBE_EVERY_MS);
    const onChange = () => void check();
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    window.addEventListener("focus", onChange);

    // Capture on window so this runs before React sees the submit.
    const onSubmit = (e: Event) => {
      if (!offlineRef.current) return;
      const form = e.target as HTMLElement | null;
      if (form?.hasAttribute("data-allow-offline")) return;
      e.preventDefault();
      e.stopPropagation();
      setNotice("That was not sent: you are offline. Try again when the connection is back.");
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 8_000);
    };
    window.addEventListener("submit", onSubmit, true);

    return () => {
      stopped = true;
      clearTimeout(warmTimer);
      clearInterval(interval);
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("submit", onSubmit, true);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const state = bannerState(offline, savedAt);
  if (state === "none" && !notice) return null;
  const when = savedAt ? savedAtLabel(savedAt, new Date()) : "";

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-lg border border-pending bg-pending/10 px-4 py-3 text-sm text-ink print:hidden"
    >
      {state === "offline-saved" && (
        <p>
          <strong>You are offline.</strong> This is a copy saved at {when}. It may be out of date, and changes cannot be saved until the
          connection is back.
        </p>
      )}
      {state === "offline-live" && (
        <p>
          <strong>You are offline.</strong> What you see may be out of date, and changes cannot be saved until the connection is back.
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
      {notice && <p className={state === "none" ? "" : "mt-2"}>{notice}</p>}
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
