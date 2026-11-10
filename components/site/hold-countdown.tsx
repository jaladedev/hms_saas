"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { announcement, formatCountdown, isUrgent, remainingAfter } from "@/lib/guest-site/hold";

/**
 * How long the room is held, counting down live. `initialSeconds` is what the server worked out when it rendered the
 * page; the countdown runs from that using only the time elapsed since the page loaded, so a wrong clock on the
 * guest's phone changes nothing (see lib/guest-site/hold.ts). When it reaches zero the page is reloaded once from the
 * server, which then shows the expired message and no Pay button. The server decides whether a hold is live: this
 * component only shows the time.
 *
 * The ticking digits are not announced (a timer is silent to screen readers by default); a polite message is spoken
 * once at two minutes and once at the end.
 */
export function HoldCountdown({ initialSeconds }: { initialSeconds: number }) {
  const router = useRouter();
  const [left, setLeft] = useState(initialSeconds);
  const [spoken, setSpoken] = useState("");
  const startedAt = useRef<number | null>(null);
  const refreshed = useRef(false);

  useEffect(() => {
    startedAt.current = Date.now();
    const tick = () => {
      const next = remainingAfter(initialSeconds, Date.now() - (startedAt.current ?? Date.now()));
      setLeft(next);
      const say = announcement(next);
      if (say) setSpoken(say);
    };
    tick();
    const timer = setInterval(tick, 1000);
    // Timers are slowed or paused in a background tab; catch up the moment the guest comes back.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [initialSeconds]);

  useEffect(() => {
    if (left > 0 || refreshed.current) return;
    refreshed.current = true;
    // A moment after the end, so the server's own clock is past it too when the page is rendered again.
    const t = setTimeout(() => router.refresh(), 1500);
    return () => clearTimeout(t);
  }, [left, router]);

  return (
    <>
      <p className="text-sm text-muted">
        Your room is held for{" "}
        <span role="timer" className={`font-semibold tabular-nums ${isUrgent(left) ? "text-pending" : "text-ink"}`}>
          {formatCountdown(left)}
        </span>{" "}
        more. Keep this page&apos;s link: it is how you come back to your booking.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {spoken}
      </p>
    </>
  );
}
