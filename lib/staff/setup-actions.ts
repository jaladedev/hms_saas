"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyRpcError } from "./refunds";
import { classifySetupError, isRoomStatus, isRoomTypeStatus, nameClashes, validateRoom, validateRoomType, validateRoomTypeEdit } from "./room-setup";
import { todayIn } from "./reservations";

/**
 * Hotel setup actions: room types and rooms. They run as the signed-in person, and the tables' own row-level
 * security allows writes only to people with property.configure, so a refusal from the database is final.
 * Failures turn into a short code in the URL; raw database text never reaches the browser.
 */

const PAGE = "/app/settings/rooms";
const uuid = z.guid();
const failWith = (err: { code?: string; message?: string }) => back(PAGE, { err: classifySetupError(err) });
const refresh = () => { revalidatePath(PAGE); revalidatePath("/app/rooms"); revalidatePath("/app/reservations/new"); };

export async function addRoomType(formData: FormData) {
  const v = validateRoomType(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const { value } = v;

  const supabase = await staffClient();
  const { data: prop } = await supabase.from("properties").select("tenant_id, currency").eq("id", value.propertyId).maybeSingle();
  if (!prop) return back(PAGE, { err: "setup_forbidden" });

  const { error } = await supabase.from("room_types").insert({
    tenant_id: prop.tenant_id, property_id: value.propertyId, name: value.name, code: value.code, slug: value.slug,
    description: value.description, amenities: value.amenities, max_adults: value.maxAdults, max_children: value.maxChildren, max_occupancy: value.maxOccupancy,
    base_rate_minor: value.baseRateMinor, is_public: value.isPublic,
  });
  if (error) return failWith(error);
  refresh();
  return ok(PAGE, "room_type_created");
}

/**
 * Changes a room type's name, description, capacity, standard price and online visibility. The code and web address
 * stay. A person without hotel-setup permission can read the row but the update matches nothing under row-level
 * security, so an empty result is treated as a refusal rather than a success.
 */
export async function updateRoomType(formData: FormData) {
  const v = validateRoomTypeEdit(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const { value } = v;

  const supabase = await staffClient();
  const { data: type } = await supabase.from("room_types").select("id, property_id").eq("id", value.roomTypeId).maybeSingle();
  if (!type) return back(PAGE, { err: "not_found" });

  const { data: others, error: othersError } = await supabase.from("room_types").select("name, slug").eq("property_id", type.property_id).neq("id", type.id);
  if (othersError) return failWith(othersError);
  if (nameClashes(value.name, others ?? [])) return back(PAGE, { err: "setup_duplicate_name" });

  const { data: changed, error } = await supabase.from("room_types").update({
    name: value.name, description: value.description, amenities: value.amenities, max_adults: value.maxAdults, max_children: value.maxChildren,
    max_occupancy: value.maxOccupancy, base_rate_minor: value.baseRateMinor, is_public: value.isPublic,
  }).eq("id", type.id).select("id");
  if (error) return failWith(error);
  if (!changed || changed.length === 0) return back(PAGE, { err: "setup_forbidden" });
  refresh();
  return ok(PAGE, "room_type_updated");
}

/**
 * Switches a room type off or on. Off stops NEW bookings (staff and online both check it); bookings already made,
 * and the type's rooms, are left alone.
 */
export async function setRoomTypeStatus(formData: FormData) {
  const parsed = z.object({ roomTypeId: uuid, status: z.string().max(20) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success || !isRoomTypeStatus(parsed.data.status)) return back(PAGE, { err: "bad_request" });
  const { roomTypeId, status } = parsed.data;

  const supabase = await staffClient();
  const { data: type } = await supabase.from("room_types").select("id").eq("id", roomTypeId).maybeSingle();
  if (!type) return back(PAGE, { err: "not_found" });

  const { data: changed, error } = await supabase.from("room_types").update({ status }).eq("id", roomTypeId).select("id");
  if (error) return failWith(error);
  if (!changed || changed.length === 0) return back(PAGE, { err: "setup_forbidden" });
  refresh();
  return ok(PAGE, status === "inactive" ? "room_type_deactivated" : "room_type_activated");
}

export async function addRoom(formData: FormData) {
  const v = validateRoom(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const { value } = v;

  const supabase = await staffClient();
  const { data: type } = await supabase.from("room_types").select("tenant_id, property_id").eq("id", value.roomTypeId).maybeSingle();
  if (!type) return back(PAGE, { err: "setup_forbidden" });

  const { error } = await supabase.from("rooms").insert({
    tenant_id: type.tenant_id, property_id: type.property_id, room_type_id: value.roomTypeId, room_number: value.roomNumber, floor: value.floor,
  });
  if (error) return failWith(error);
  refresh();
  return ok(PAGE, "room_added");
}

export async function setRoomStatus(formData: FormData) {
  const parsed = z.object({ roomId: uuid, status: z.string().max(20) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success || !isRoomStatus(parsed.data.status)) return back(PAGE, { err: "bad_request" });
  const { roomId, status } = parsed.data;

  const supabase = await staffClient();
  const { data: room } = await supabase.from("rooms").select("id, property_id").eq("id", roomId).maybeSingle();
  if (!room) return back(PAGE, { err: "not_found" });

  // Taking a room out of use while guests or blocks are still on it would strand them, so refuse until they are moved.
  if (status !== "active") {
    const { data: prop } = await supabase.from("properties").select("timezone").eq("id", room.property_id).maybeSingle();
    const today = todayIn(prop?.timezone ?? "UTC", new Date());
    const { count, error: claimError } = await supabase.from("room_inventory_claims")
      .select("id", { count: "exact", head: true }).eq("room_id", roomId).eq("status", "active").gt("end_date", today);
    if (claimError) return back(PAGE, { err: classifyRpcError(claimError.message).code });
    // Out of service is a temporary pause the board already flags, so only retiring is blocked by bookings.
    if (status === "retired" && (count ?? 0) > 0) return back(PAGE, { err: "room_has_bookings" });
  }

  const { error } = await supabase.from("rooms").update({ operational_status: status }).eq("id", roomId);
  if (error) return failWith(error);
  refresh();
  return ok(PAGE, "room_status_changed");
}
