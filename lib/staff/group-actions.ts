"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import {
  classifyGroupError,
  parseCreateGroupForm,
  parseGroupId,
  parseRoomingForm,
  parseRoomingRemoveForm,
  parseUnitForm,
  parseUpdateGroupForm,
  type GroupErrorCode,
  type GroupOkCode,
} from "./groups";

/**
 * Group booking actions (migration 150). Each runs as the signed-in person; the database requires group.manage at that hotel and the
 * group_bookings flag, holds the rooms all or nothing, and answers with a refusal shown as a short code, never as database text.
 * The create form carries a key made when the page was drawn, so a double tap repeats the first answer.
 */
const LIST = "/app/groups";
const detail = (id: string) => `${LIST}/${id}`;
const fail = (path: string, code: GroupErrorCode): never => back(path, { grouperr: code });
const done = (path: string, code: GroupOkCode): never => back(path, { group: code });

export async function createGroup(formData: FormData) {
  const v = parseCreateGroupForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const f = v.value;
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("create_group", {
    p_property: f.propertyId,
    p_name: f.name,
    p_company: f.company as string,
    p_contact_name: f.contactName,
    p_contact_phone: f.contactPhone as string,
    p_contact_email: f.contactEmail as string,
    p_arrival: f.arrival,
    p_departure: f.departure,
    p_release: f.release,
    p_notes: f.notes as string,
    p_rooms: f.rooms,
    p_key: f.key,
  });
  if (error) return fail(LIST, classifyGroupError(error.message));
  revalidatePath(LIST);
  const id = (data as { group_id?: unknown } | null)?.group_id;
  return done(typeof id === "string" ? detail(id) : LIST, "group_created");
}

export async function updateGroup(formData: FormData) {
  const v = parseUpdateGroupForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const f = v.value;
  const path = detail(f.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_group", {
    p_group: f.groupId,
    p_company: f.company as string,
    p_contact_name: f.contactName,
    p_contact_phone: f.contactPhone as string,
    p_contact_email: f.contactEmail as string,
    p_release: f.release,
    p_notes: f.notes as string,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_updated");
}

export async function cancelGroup(formData: FormData) {
  const id = parseGroupId(formData.get("groupId"));
  if (!id) return fail(LIST, "group_invalid");
  const supabase = await staffClient();
  const { error } = await supabase.rpc("cancel_group", { p_group: id });
  if (error) return fail(detail(id), classifyGroupError(error.message));
  revalidatePath(LIST);
  revalidatePath(detail(id));
  return done(detail(id), "group_cancelled");
}

export async function useGroupRoom(formData: FormData) {
  const v = parseUnitForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("use_group_unit", { p_group: v.value.groupId, p_room_type: v.value.roomTypeId });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_unit_used");
}

export async function addRoomingEntry(formData: FormData) {
  const v = parseRoomingForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("add_rooming_entry", {
    p_group: v.value.groupId,
    p_guest: v.value.guest,
    p_room_type: v.value.roomTypeId as string,
    p_notes: v.value.notes as string,
  });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_rooming_added");
}

export async function removeRoomingEntry(formData: FormData) {
  const v = parseRoomingRemoveForm(Object.fromEntries(formData));
  if (!v.ok) return fail(LIST, v.code);
  const path = detail(v.value.groupId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("remove_rooming_entry", { p_entry: v.value.entryId });
  if (error) return fail(path, classifyGroupError(error.message));
  revalidatePath(path);
  return done(path, "group_rooming_removed");
}
