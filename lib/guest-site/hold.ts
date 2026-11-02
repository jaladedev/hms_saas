/**
 * The hold countdown on the booking page: the arithmetic and the wording, kept apart from React so it can be tested.
 *
 * The server works out how many seconds are left when it renders the page, and the browser counts down from that
 * number using the time elapsed since the page loaded (a difference of two readings of the same clock). The browser
 * therefore never compares its own clock with the server's, so a phone with the wrong date still shows the right
 * time left. The server stays the authority: paying needs a live hold, whatever the page shows.
 */

/** Whole seconds until `expiresIso` (rounded up, never negative); 0 when there is no hold or the date cannot be read. */
export function secondsRemaining(expiresIso: string | null, nowMs: number): number {
  if (!expiresIso) return 0;
  const at = Date.parse(expiresIso);
  if (Number.isNaN(at) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** What is left `elapsedMs` after the page told us `initialSeconds`. A clock that moved backwards counts as no time passed. */
export function remainingAfter(initialSeconds: number, elapsedMs: number): number {
  const start = Number.isFinite(initialSeconds) ? Math.max(0, initialSeconds) : 0;
  const passed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.max(0, Math.ceil(start - passed / 1000));
}

/** "12:34", "0:09". Hours are folded into minutes: a hold lasts well under an hour. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Under two minutes the countdown is shown as a warning. */
export const WARN_BELOW_SECONDS = 120;
export const isUrgent = (seconds: number): boolean => seconds > 0 && seconds <= WARN_BELOW_SECONDS;

/** A sentence for a screen reader, spoken only when something worth interrupting for happens. */
export function announcement(seconds: number): string | null {
  if (seconds <= 0) return "Your room hold has ended.";
  if (seconds === WARN_BELOW_SECONDS) return "Your room hold ends in 2 minutes.";
  return null;
}
