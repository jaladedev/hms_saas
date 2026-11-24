/** What the error pages say. Kept apart so it can be tested and so no page ever shows the error's own text, which can hold data. */
export const ERROR_PAGE_TITLE = "Something went wrong";
export const ERROR_PAGE_BODY = "We could not complete that. Try again, and if it keeps happening tell support the reference below.";
export function errorReference(digest: string | undefined): string | null {
  return digest && /^[A-Za-z0-9_-]{3,40}$/.test(digest) ? digest : null;
}

/** Shown when the failure was the connection, not the app: the person must check whether the change went through before repeating it. */
export const CONNECTION_ERROR_TITLE = "The connection dropped";
export const CONNECTION_ERROR_BODY =
  "We could not reach the server. Your last change may not have been saved: check the page for it before doing it again. Then try again when the connection is back.";

/** True for the browser's own "could not reach the server" failures. Looks only at the message's kind, never shows it. */
export function isConnectionError(error: { name?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const text = `${error.name ?? ""} ${error.message ?? ""}`.toLowerCase();
  return /failed to fetch|load failed|networkerror|network error|fetch failed|network request failed/.test(text);
}

/** Shown under the connection message when the change that was being sent was kept on this computer. */
export const RESCUED_BODY =
  "was kept on this computer and will be sent when the connection is back. Press Try again; there is no need to do it again.";
