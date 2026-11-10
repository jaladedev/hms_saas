"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { siteOrigin } from "@/lib/staff/auth";
import { classifyPlatformError, normalizeHost, validateNewHotel, type PlatformCode, type PlatformOk } from "./hotel";

/**
 * Platform administration actions. Each runs as the signed-in platform admin, so the database (migration 050) decides what
 * they may do and records their own login as the actor. The one step that cannot run as them is creating a login for a new
 * owner: that uses the service key, and only after the database has said this person is an admin, so a refused request
 * never sends an email.
 */

const uuid = z.guid();
const NEW = "/platform/new";
const LIST = "/platform";

function go(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}
const fail = (path: string, code: PlatformCode, extra: Record<string, string> = {}): never => go(path, { err: code, ...extra });
const done = (path: string, code: PlatformOk): never => go(path, { ok: code });

async function platformClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login?next=/platform");
  return supabase;
}

async function adminClient(path: string) {
  const supabase = await platformClient();
  const level = await supabase.rpc("platform_level");
  if (level.error) return fail(path, "unavailable");
  if (level.data !== "admin") return fail(path, "forbidden");
  return supabase;
}

/** Creates a hotel group, its first property, an unverified domain, its owner and (if asked) an inactive Paystack account. */
export async function createHotel(formData: FormData) {
  const v = validateNewHotel(Object.fromEntries(formData));
  if (!v.ok) return fail(NEW, "bad_request", { field: v.field });
  const h = v.value;

  const supabase = await adminClient(NEW);

  // A repeated short name is caught before an invitation is sent, so a refused request sends no email. The database still
  // decides: two people creating the same name at once get one refusal from its unique rule.
  const existing = await supabase.rpc("platform_list_tenants");
  if (existing.error) return fail(NEW, classifyPlatformError(existing.error));
  if (Array.isArray(existing.data) && existing.data.some((t) => (t as { slug?: string }).slug === h.slug)) return fail(NEW, "slug_taken");

  const service = createServiceClient();
  const found = await service.rpc("find_user_id_by_email", { p_email: h.ownerEmail });
  if (found.error) return fail(NEW, "invite_failed");
  let ownerId = (found.data as string | null) ?? null;
  if (!ownerId) {
    const origin = siteOrigin(await headers(), process.env.NODE_ENV === "production");
    if (!origin) return fail(NEW, "invite_failed");
    const invited = await service.auth.admin.inviteUserByEmail(h.ownerEmail, {
      redirectTo: `${origin}/auth/callback?next=/reset-password`,
    });
    if (invited.error || !invited.data.user) return fail(NEW, "invite_failed");
    ownerId = invited.data.user.id;
  }

  const created = await supabase.rpc("platform_create_tenant", {
    p_name: h.name,
    p_slug: h.slug,
    p_property_name: h.propertyName,
    p_property_code: h.propertyCode,
    p_city: h.city || null,
    p_state: h.state || null,
    p_timezone: h.timezone,
    p_currency: h.currency,
    p_host: h.host,
    p_owner_user_id: ownerId,
    p_paystack_secret_reference: h.secretReference || null,
    p_paystack_mode: h.secretReference ? h.paymentMode : null,
  });
  if (created.error) return fail(NEW, classifyPlatformError(created.error));
  const tenantId = (created.data as { tenant_id?: string } | null)?.tenant_id;
  revalidatePath(LIST);
  if (!tenantId || !uuid.safeParse(tenantId).success) return done(LIST, "created");
  return done(`/platform/${tenantId}`, "created");
}

export async function setTenantStatus(formData: FormData) {
  const p = z
    .object({ tenantId: uuid, status: z.enum(["active", "suspended", "closed"]), reason: z.string().max(500) })
    .safeParse(Object.fromEntries(formData));
  if (!p.success) return fail(LIST, "bad_request");
  const page = `/platform/${p.data.tenantId}`;
  const supabase = await adminClient(page);
  const { data, error } = await supabase.rpc("platform_set_tenant_status", {
    p_tenant: p.data.tenantId,
    p_status: p.data.status,
    p_reason: p.data.reason,
  });
  if (error) return fail(page, classifyPlatformError(error));
  revalidatePath(page);
  return done(page, (data as { changed?: boolean } | null)?.changed === false ? "unchanged" : "status");
}

export async function addDomain(formData: FormData) {
  const p = z
    .object({ tenantId: uuid, propertyId: z.union([uuid, z.literal("")]), host: z.string().max(400) })
    .safeParse(Object.fromEntries(formData));
  if (!p.success) return fail(LIST, "bad_request");
  const page = `/platform/${p.data.tenantId}`;
  const supabase = await adminClient(page);
  const { error } = await supabase.rpc("platform_add_domain", {
    p_tenant: p.data.tenantId,
    p_property: p.data.propertyId || null,
    p_host: normalizeHost(p.data.host),
  });
  if (error) return fail(page, classifyPlatformError(error));
  revalidatePath(page);
  return done(page, "domain_added");
}

export async function setDomainVerified(formData: FormData) {
  const p = z.object({ tenantId: uuid, domainId: uuid, verified: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(formData));
  if (!p.success) return fail(LIST, "bad_request");
  const page = `/platform/${p.data.tenantId}`;
  const supabase = await adminClient(page);
  const verified = p.data.verified === "true";
  const { data, error } = await supabase.rpc("platform_set_domain_verified", { p_domain: p.data.domainId, p_verified: verified });
  if (error) return fail(page, classifyPlatformError(error));
  revalidatePath(page);
  return done(
    page,
    (data as { changed?: boolean } | null)?.changed === false ? "unchanged" : verified ? "domain_verified" : "domain_unverified",
  );
}

export async function setProviderStatus(formData: FormData) {
  const p = z
    .object({ tenantId: uuid, accountId: uuid, status: z.enum(["inactive", "active", "disabled"]) })
    .safeParse(Object.fromEntries(formData));
  if (!p.success) return fail(LIST, "bad_request");
  const page = `/platform/${p.data.tenantId}`;
  const supabase = await adminClient(page);
  const { data, error } = await supabase.rpc("platform_set_provider_status", { p_account: p.data.accountId, p_status: p.data.status });
  if (error) return fail(page, classifyPlatformError(error));
  revalidatePath(page);
  return done(page, (data as { changed?: boolean } | null)?.changed === false ? "unchanged" : "provider");
}

export async function setSubscription(formData: FormData) {
  const day = z.union([z.literal(""), z.iso.date()]);
  const p = z
    .object({
      tenantId: uuid,
      plan: z.string().max(60),
      status: z.enum(["trial", "active", "past_due", "cancelled"]),
      trialEnds: day,
      periodEnd: day,
    })
    .safeParse(Object.fromEntries(formData));
  if (!p.success) return fail(LIST, "bad_request");
  const page = `/platform/${p.data.tenantId}`;
  const supabase = await adminClient(page);
  const at = (d: string) => (d ? `${d}T00:00:00Z` : null);
  const { error } = await supabase.rpc("platform_set_subscription", {
    p_tenant: p.data.tenantId,
    p_plan_code: p.data.plan,
    p_status: p.data.status,
    p_trial_ends_at: at(p.data.trialEnds),
    p_period_end: at(p.data.periodEnd),
  });
  if (error) return fail(page, classifyPlatformError(error));
  revalidatePath(page);
  return done(page, "plan_set");
}

export async function setEntitlement(formData: FormData) {
  const p = z
    .object({ tenantId: uuid, key: z.string().max(80), enabled: z.enum(["true", "false"]) })
    .safeParse(Object.fromEntries(formData));
  if (!p.success) return fail(LIST, "bad_request");
  const page = `/platform/${p.data.tenantId}`;
  const supabase = await adminClient(page);
  const { data, error } = await supabase.rpc("platform_set_entitlement", {
    p_tenant: p.data.tenantId,
    p_feature_key: p.data.key,
    p_enabled: p.data.enabled === "true",
  });
  if (error) return fail(page, classifyPlatformError(error));
  revalidatePath(page);
  return done(page, (data as { changed?: boolean } | null)?.changed === false ? "unchanged" : "feature_set");
}

/** Sends an owner who has not accepted yet a new invitation. The database confirms the person is an owner of this group first. */
export async function resendOwnerInvite(formData: FormData) {
  const p = z.object({ tenantId: uuid, userId: uuid }).safeParse(Object.fromEntries(formData));
  if (!p.success) return fail(LIST, "bad_request");
  const page = `/platform/${p.data.tenantId}`;
  const supabase = await adminClient(page);
  const check = await supabase.rpc("platform_owner_invite_check", { p_tenant: p.data.tenantId, p_user: p.data.userId });
  if (check.error) return fail(page, classifyPlatformError(check.error));
  const info = check.data as { email?: string; accepted?: boolean } | null;
  if (!info?.email) return fail(page, "not_found");
  if (info.accepted) return fail(page, "owner_active");

  const origin = siteOrigin(await headers(), process.env.NODE_ENV === "production");
  if (!origin) return fail(page, "invite_failed");
  const sent = await createServiceClient().auth.admin.inviteUserByEmail(info.email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });
  if (sent.error) return fail(page, "invite_failed");
  const logged = await supabase.rpc("platform_log_owner_invite", { p_tenant: p.data.tenantId, p_user: p.data.userId });
  if (logged.error) return fail(page, classifyPlatformError(logged.error));
  revalidatePath(page);
  return done(page, "invite_resent");
}
