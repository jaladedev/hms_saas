"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { parseIsoDate } from "./reservations";
import { HOUSEKEEPING_STATUSES } from "./room-board";

/**
 * Staff room actions: housekeeping status, blocking a room and removing a block. Each runs as the
 * signed-in person, so the database decides who may do what; these functions carry the request and
 * turn the answer into a redirect with a short code the page can explain.
 */

const BOARD = "/app/rooms";
const key = z.string().min(8).max(100);
const uuid = z.guid();

export async function setHousekeeping(formData: FormData) {
  const parsed = z.object({ roomId: uuid, status: z.enum(HOUSEKEEPING_STATUSES) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(BOARD, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_housekeeping_status", { p_room_id: parsed.data.roomId, p_status: parsed.data.status });
  if (error) return fail(BOARD, error.message);
  revalidatePath(BOARD);
  return ok(BOARD, "housekeeping_set");
}

export async function blockRoom(formData: FormData) {
  const parsed = z.object({
    roomId: uuid, idempotencyKey: key, start: z.string().max(10), end: z.string().max(10), reason: z.string().max(500),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(BOARD, { err: "bad_request" });
  const start = parseIsoDate(parsed.data.start);
  const end = parseIsoDate(parsed.data.end);
  const reason = parsed.data.reason.trim();
  if (!start || !end || end <= start || !reason) return back(BOARD, { err: "block_invalid" });

  const supabase = await staffClient();
  // 'fail' only reports clashes: moving guests to other rooms is a decision for a person, made on the booking.
  const { data, error } = await supabase.rpc("create_room_block", {
    p_room_id: parsed.data.roomId, p_start: start, p_end: end, p_reason: reason, p_resolution: "fail",
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return fail(BOARD, error.message);
  const result = data as { created?: boolean; conflicts?: unknown[] } | null;
  if (!result?.created) return back(BOARD, { err: "block_conflict", n: result?.conflicts?.length ?? 1 });
  revalidatePath(BOARD);
  return ok(BOARD, "blocked");
}

export async function releaseBlock(formData: FormData) {
  const parsed = z.object({ blockId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(BOARD, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("release_room_block", { p_block_id: parsed.data.blockId });
  if (error) return fail(BOARD, error.message);
  revalidatePath(BOARD);
  return ok(BOARD, "block_released");
}
