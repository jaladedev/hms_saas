/** What the error pages say. Kept apart so it can be tested and so no page ever shows the error's own text, which can hold data. */
export const ERROR_PAGE_TITLE = "Something went wrong";
export const ERROR_PAGE_BODY = "We could not complete that. Try again, and if it keeps happening tell support the reference below.";
export function errorReference(digest: string | undefined): string | null {
  return digest && /^[A-Za-z0-9_-]{3,40}$/.test(digest) ? digest : null;
}
