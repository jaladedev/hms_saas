/**
 * Resetting a booking's guest links (migration 066, `reset_guest_links`). Pure helpers so they can be tested: the form's
 * reason check and the wording of refusals. The database decides who may (`reservation.modify`).
 */
import type { ErrorCode } from "./refunds";

export const GUEST_LINK_REASON_MAX = 200;

export function parseGuestLinkReason(raw: unknown): { ok: true; reason: string } | { ok: false; code: ErrorCode } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason === "" || reason.length > GUEST_LINK_REASON_MAX) return { ok: false, code: "gl_reason" };
  return { ok: true, reason };
}

export function classifyGuestLinkError(message: string): ErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "se_duplicate";
  if (/POLICY_VIOLATION: reason/.test(message)) return "gl_reason";
  if (/NOT_FOUND/.test(message)) return "not_found";
  return "unknown";
}

export function guestLinkResultCode(data: unknown): "guest_links_reset" | "guest_links_reset_no_email" {
  const d = data as { email_queued?: boolean } | null;
  return d?.email_queued === false ? "guest_links_reset_no_email" : "guest_links_reset";
}
