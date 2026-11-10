"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { classifyMaintenanceError, REQUEST_PRIORITIES, zonedToIso } from "./maintenance";
import type { OkCode } from "./refunds";

/**
 * Staff actions on maintenance requests (migration 026). Each runs as the signed-in person, so the database decides
 * who may do what; these functions carry the request and turn the answer into a redirect with a short code.
 * Reporting can be done from the maintenance list or from a room card; every other action comes from the list or
 * from the request's own page, and returns to wherever it started.
 */

const LIST = "/app/maintenance";
const ROOMS = "/app/rooms";
const uuid = z.guid();
const key = z.string().min(8).max(100);
const maybeUuid = z.union([uuid, z.literal("")]).default("");

/** Where to go back to: the list, the room board (reporting only), or the request's own page. */
function pageFor(from: "list" | "detail" | "rooms", requestId?: string): string {
  if (from === "rooms") return ROOMS;
  if (from === "detail" && requestId) return `${LIST}/${requestId}`;
  return LIST;
}

function finish(page: string, requestId: string | null, error: { message: string } | null, code: OkCode): never {
  if (error) {
    const own = classifyMaintenanceError(error.message);
    return own ? back(page, { err: own }) : fail(page, error.message);
  }
  revalidatePath(LIST);
  revalidatePath(ROOMS);
  if (requestId) revalidatePath(`${LIST}/${requestId}`);
  return ok(page, code);
}

export async function reportRequest(formData: FormData) {
  const parsed = z
    .object({
      propertyId: maybeUuid,
      roomId: maybeUuid,
      location: z.string().max(100).default(""),
      title: z.string().max(120),
      description: z.string().max(2000).default(""),
      priority: z.enum(REQUEST_PRIORITIES),
      due: z.string().max(16).default(""),
      assignedTo: maybeUuid,
      idempotencyKey: key,
      from: z.enum(["list", "rooms"]).default("list"),
    })
    .safeParse(Object.fromEntries(formData));
  const page = pageFor(parsed.success ? parsed.data.from : "list");
  if (!parsed.success) return back(page, { err: "mt_invalid" });

  const d = parsed.data;
  const title = d.title.trim();
  const location = d.roomId ? "" : d.location.trim();
  if (!title) return back(page, { err: "mt_invalid" });
  if (!d.roomId && !location) return back(page, { err: "mt_place" });

  const supabase = await staffClient();
  // A room decides its own property, so a form with several hotels cannot pair a room with the wrong one.
  let propertyId = d.propertyId;
  if (d.roomId) {
    const { data: rm } = await supabase.from("rooms").select("property_id").eq("id", d.roomId).maybeSingle();
    if (!rm) return back(page, { err: "mt_invalid" });
    propertyId = rm.property_id;
  }
  if (!propertyId) return back(page, { err: "mt_place" });
  // The form's time is the hotel's wall-clock time, so it is read in the property's timezone.
  let dueAt: string | null = null;
  if (d.due) {
    const { data: pr } = await supabase.from("properties").select("timezone").eq("id", propertyId).maybeSingle();
    dueAt = zonedToIso(d.due, pr?.timezone ?? "UTC");
    if (!dueAt) return back(page, { err: "mt_invalid" });
  }
  const { error } = await supabase.rpc("report_maintenance_request", {
    p_property_id: propertyId,
    p_room_id: d.roomId || null,
    p_location: location || null,
    p_title: title,
    p_description: d.description.trim() || null,
    p_priority: d.priority,
    p_due_at: dueAt,
    p_assigned_to: d.assignedTo || null,
    p_idempotency_key: d.idempotencyKey,
  });
  return finish(page, null, error, "mt_reported");
}

const target = z.object({ requestId: uuid, from: z.enum(["list", "detail"]).default("list") });

export async function claimRequest(formData: FormData) {
  const parsed = target.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.from, parsed.data.requestId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("claim_maintenance_request", { p_request_id: parsed.data.requestId });
  return finish(page, parsed.data.requestId, error, "mt_claimed");
}

export async function startRequest(formData: FormData) {
  const parsed = target.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.from, parsed.data.requestId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("start_maintenance_request", { p_request_id: parsed.data.requestId });
  return finish(page, parsed.data.requestId, error, "mt_started");
}

/** Resolving never releases a room block; when one is still active the message says so. */
export async function resolveRequest(formData: FormData) {
  const parsed = target.extend({ note: z.string().max(1000).default("") }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "mt_invalid" });
  const page = pageFor(parsed.data.from, parsed.data.requestId);
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("resolve_maintenance_request", {
    p_request_id: parsed.data.requestId,
    p_note: parsed.data.note.trim() || null,
  });
  const stillBlocked = (data as { block_still_active?: boolean } | null)?.block_still_active === true;
  return finish(page, parsed.data.requestId, error, stillBlocked ? "mt_resolved_block" : "mt_resolved");
}

export async function cancelRequest(formData: FormData) {
  const parsed = target.extend({ reason: z.string().max(200) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "mt_reason" });
  const page = pageFor(parsed.data.from, parsed.data.requestId);
  const reason = parsed.data.reason.trim();
  if (!reason) return back(page, { err: "mt_reason" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("cancel_maintenance_request", { p_request_id: parsed.data.requestId, p_reason: reason });
  return finish(page, parsed.data.requestId, error, "mt_cancelled");
}

/** An empty `userId` takes the request back (unassigns it). */
export async function assignRequest(formData: FormData) {
  const parsed = target.extend({ userId: maybeUuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.from, parsed.data.requestId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("assign_maintenance_request", {
    p_request_id: parsed.data.requestId,
    p_user_id: parsed.data.userId || null,
  });
  return finish(page, parsed.data.requestId, error, parsed.data.userId ? "mt_assigned" : "mt_unassigned");
}

export async function setRequestPriority(formData: FormData) {
  const parsed = target.extend({ priority: z.enum(REQUEST_PRIORITIES) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "mt_invalid" });
  const page = pageFor(parsed.data.from, parsed.data.requestId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_maintenance_priority", {
    p_request_id: parsed.data.requestId,
    p_priority: parsed.data.priority,
  });
  return finish(page, parsed.data.requestId, error, "mt_priority");
}

/** An empty `blockId` clears the link. Linking only records which block the room is out of sale for; it creates and releases nothing. */
export async function linkBlock(formData: FormData) {
  const parsed = target.extend({ blockId: maybeUuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.from, parsed.data.requestId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("link_maintenance_block", {
    p_request_id: parsed.data.requestId,
    p_block_id: parsed.data.blockId || null,
  });
  return finish(page, parsed.data.requestId, error, parsed.data.blockId ? "mt_block_linked" : "mt_block_unlinked");
}
