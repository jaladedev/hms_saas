"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { checkGuestForm, checkGuestProfile } from "./guests";
import { checkGuestIdForm, classifyGuestIdError } from "./guest-id";

/** Saves a guest's contact details through update_guest (permission, validation and audit are in the database). */
export async function updateGuest(formData: FormData) {
  const parsed = z
    .object({
      guestId: z.guid(),
      full_name: z.string().max(400),
      email: z.string().max(400),
      phone: z.string().max(400),
      address: z.string().max(1000),
      country_code: z.string().max(10),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back("/app/guests", { err: "bad_request" });
  const { guestId, ...form } = parsed.data;
  const page = `/app/guests/${guestId}`;
  const problem = checkGuestForm(form);
  if (problem) return back(page, { err: problem });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_guest", {
    p_guest: guestId,
    p_full_name: form.full_name,
    p_email: form.email,
    p_phone: form.phone,
    p_address: form.address,
    p_country_code: form.country_code,
  });
  if (error) return fail(page, error.message);
  revalidatePath(page);
  revalidatePath("/app/guests");
  return ok(page, "guest_updated");
}

/**
 * Adds a guest on their own, through create_guest (permission, validation, the same-email rule and audit are in the database).
 * A guest with that email already in the hotel group is not added twice: the person lands on the existing guest's page.
 */
export async function createGuest(formData: FormData) {
  const NEW = "/app/guests/new";
  const parsed = z
    .object({
      propertyId: z.guid(),
      full_name: z.string().max(400),
      email: z.string().max(400),
      phone: z.string().max(400),
      address: z.string().max(1000),
      country_code: z.string().max(10),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(NEW, { err: "bad_request" });
  const { propertyId, ...form } = parsed.data;
  const problem = checkGuestForm(form);
  if (problem) return back(NEW, { err: problem });

  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("create_guest", {
    p_property: propertyId,
    p_full_name: form.full_name,
    p_email: form.email,
    p_phone: form.phone,
    p_address: form.address,
    p_country_code: form.country_code,
  });
  if (error) return fail(NEW, error.message);
  const result = data as { guest_id?: unknown; created?: unknown } | null;
  if (!result || typeof result.guest_id !== "string") return back(NEW, { err: "guest_failed" });
  revalidatePath("/app/guests");
  return ok(`/app/guests/${result.guest_id}`, result.created === true ? "guest_created" : "guest_exists");
}

/**
 * Saves a guest's VIP flag and private notes through set_guest_profile (permission, limits and audit are in the database).
 * A checkbox that is not ticked sends nothing, so a missing "vip" means false.
 */
export async function saveGuestProfile(formData: FormData) {
  const parsed = z
    .object({ guestId: z.guid(), notes: z.string().max(4000), vip: z.string().max(10).optional() })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back("/app/guests", { err: "bad_request" });
  const { guestId, notes, vip } = parsed.data;
  const page = `/app/guests/${guestId}`;
  const problem = checkGuestProfile({ notes });
  if (problem) return back(page, { err: problem });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_guest_profile", { p_guest: guestId, p_vip: vip === "on", p_notes: notes });
  if (error) return fail(page, error.message);
  revalidatePath(page);
  revalidatePath("/app/guests");
  return ok(page, "guest_profile_saved");
}

/**
 * Saves or clears a guest's ID type and number through set_guest_id (migration 183): both blank clears it. The number is sent to the
 * database and nowhere else: it is not put in the address, the audit trail or a log line. Permission (guest.manage) is the database's.
 */
export async function saveGuestId(formData: FormData) {
  const parsed = z.object({ guestId: z.guid(), id_type: z.string().max(40), id_number: z.string().max(120) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back("/app/guests", { err: "bad_request" });
  const { guestId, id_type, id_number } = parsed.data;
  const page = `/app/guests/${guestId}`;
  const problem = checkGuestIdForm({ id_type, id_number });
  if (problem) return back(page, { err: problem });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_guest_id", { p_guest: guestId, p_type: id_type, p_number: id_number });
  if (error) {
    const c = classifyGuestIdError(error);
    return back(page, { err: c === "unknown" ? "guest_id_forbidden" : c });
  }
  revalidatePath(page);
  return ok(page, id_type.trim() === "" ? "guest_id_cleared" : "guest_id_saved");
}

export type RevealedGuestId = { ok: true; id_type: string; id_number: string } | { ok: false };

/** Shows the full number to someone who holds guest.id_view. The database writes an audit row for every call. Returns the number to the caller only. */
export async function revealGuestId(guestId: string): Promise<RevealedGuestId> {
  if (!z.guid().safeParse(guestId).success) return { ok: false };
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("guest_id_reveal", { p_guest: guestId });
  const d = data as { id_type?: string; id_number?: string } | null;
  if (error || !d || !d.id_number || !d.id_type) return { ok: false };
  return { ok: true, id_type: d.id_type, id_number: d.id_number };
}
