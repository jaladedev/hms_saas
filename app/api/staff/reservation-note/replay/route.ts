import { revalidatePath } from "next/cache";
import { classifyNoteReplayError, noteReplayBodySchema, type ReplayResult } from "@/lib/offline/replay";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

/**
 * Sends staff notes on bookings that were saved offline, in the order they were made. Each runs as the signed-in person through
 * `set_reservation_note_if_unchanged` (migration 190), so the database decides: permission (reservation.modify), the 1000 character
 * limit, and, because a note replaces the whole text, that the booking's note is still the text the person replaced. If someone else
 * changed it meanwhile the answer is a refusal (`changed`) and nothing is written; the app keeps what the person typed.
 *
 * Sending the same note twice is harmless (a note already saved as this text is a no-op), so a request whose answer was lost can
 * be sent again. The time the note was saved (`madeAt`) is kept inside the database's bounds and recorded in the audit.
 */
export async function POST(request: Request) {
  // A cross-site form cannot send JSON, and the session cookie is not sent cross-site anyway.
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return Response.json({ error: "bad_request" }, { status: 415, headers });
  }
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: "signed_out" }, { status: 401, headers });

  const parsed = noteReplayBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400, headers });

  const results: ReplayResult[] = [];
  const touched = new Set<string>();
  for (const item of parsed.data.items) {
    if (item.userId !== auth.user.id) {
      results.push({ id: item.id, status: "rejected", reason: "other_user" });
      continue;
    }
    const { error } = await supabase.rpc("set_reservation_note_if_unchanged", {
      p_reservation: item.reservationId,
      p_note: item.note,
      p_expected: item.expected,
      p_at: item.madeAt ?? null,
    });
    if (error) {
      results.push({ id: item.id, ...classifyNoteReplayError(error.message) });
    } else {
      results.push({ id: item.id, status: "done" });
      touched.add(item.reservationId);
    }
  }

  for (const id of touched) revalidatePath(`/app/reservations/${id}`);
  return Response.json({ results }, { headers });
}
