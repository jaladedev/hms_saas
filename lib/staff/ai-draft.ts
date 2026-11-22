/** The state of the reply draft form (see ai-draft-actions.ts). Kept apart because a "use server" file may export only actions. */
export type DraftState = { draft: string | null; error: string | null };
export const emptyDraftState: DraftState = { draft: null, error: null };
