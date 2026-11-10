/**
 * Removes stored room photo files whose picture is gone (migration 088). The database queues each deleted picture's path;
 * this claims a batch, asks the file store to remove it and tells the database which paths are done. If the file store
 * refuses, nothing is cleared and the same paths are tried on the next run. A path whose file is already gone is not an
 * error for the file store, so it clears normally.
 */

export type PhotoCleanupDeps = {
  claim(limit: number): Promise<string[]>;
  remove(paths: string[]): Promise<{ error: string | null }>;
  finish(paths: string[]): Promise<number>;
};
export type PhotoCleanupResult = { claimed: number; cleared: number; error: string | null };

export async function drainPhotoCleanup(deps: PhotoCleanupDeps, limit = 50): Promise<PhotoCleanupResult> {
  const paths = await deps.claim(limit);
  if (paths.length === 0) return { claimed: 0, cleared: 0, error: null };
  const { error } = await deps.remove(paths);
  if (error) return { claimed: paths.length, cleared: 0, error };
  return { claimed: paths.length, cleared: await deps.finish(paths), error: null };
}
