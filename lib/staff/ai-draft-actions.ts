"use server";

import { z } from "zod";
import { staffClient } from "./action-helpers";
import type { DraftState } from "./ai-draft";
import { generateReplyDraft, parseDraftContext } from "@/lib/ai/reply-draft";
import { enforceRateLimits } from "@/lib/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

const WORDS = {
  off: "Reply drafts are not switched on for your hotel group. Ask the platform team.",
  bad: "That message could not be found.",
  busy: "The drafting service is busy, or you have drafted a lot this hour. Try again in a little while.",
  not_configured: "Reply drafts are not set up on this server yet.",
  failed: "A draft could not be written. Write the reply yourself, or try again.",
} as const;

/** Asks for a draft reply to one guest message. The draft goes back to the form only: it is not sent, saved or logged. */
export async function draftReply(_prev: DraftState, formData: FormData): Promise<DraftState> {
  const parsed = z.object({ id: z.guid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { draft: null, error: WORDS.bad };
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("ai_reply_context", { p_message: parsed.data.id });
  if (error) return { draft: null, error: /ai off/.test(error.message) ? WORDS.off : WORDS.bad };
  const ctx = parseDraftContext(data);
  const propertyId =
    data && typeof data === "object" && "property_id" in data ? String((data as { property_id: unknown }).property_id) : "";
  if (!ctx || !propertyId) return { draft: null, error: WORDS.failed };

  const db = createServiceClient();
  const limit = await enforceRateLimits(
    async (key, max, windowSeconds) => {
      const { data: d, error: e } = await db.rpc("consume_rate_limit", { p_key: key, p_limit: max, p_window_seconds: windowSeconds });
      if (e) throw new Error(e.message);
      return d as { allowed: boolean; retry_after_seconds: number };
    },
    [{ rule: "aiDraft", subject: propertyId }],
  ).catch(() => null);
  if (!limit) return { draft: null, error: WORDS.failed };
  if (!limit.allowed) return { draft: null, error: WORDS.busy };

  const result = await generateReplyDraft(ctx, { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.AI_DRAFT_MODEL });
  return result.ok ? { draft: result.draft, error: null } : { draft: null, error: WORDS[result.reason] };
}
