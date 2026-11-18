/** The wording for night audit results, kept apart from the action helpers so the shared notice can use it without importing them. */

export type NightAuditErrorCode = "na_future" | "na_old" | "na_day" | "na_closed" | "na_note_needed" | "na_note_length";

export const NIGHT_AUDIT_ERROR_MESSAGES: Record<NightAuditErrorCode, string> = {
  na_future: "That day has not happened yet. A day can be closed once it is today or earlier.",
  na_old: "That day is more than a year back and can no longer be closed from here.",
  na_day: "Choose the day to close.",
  na_closed: "That day is already closed. Nothing was changed.",
  na_note_needed: "Some items are still open. Write a short note saying why you are closing the day anyway, or deal with them first.",
  na_note_length: "The note must be between 5 and 500 characters.",
};

export const NIGHT_AUDIT_OK_MESSAGES = {
  na_closed_clean: "Day closed. Its figures are kept as they are now.",
  na_closed_open: "Day closed with items still open. Your note and the open items are kept with it.",
} as const;
export type NightAuditOkCode = keyof typeof NIGHT_AUDIT_OK_MESSAGES;
