"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import {
  API_ERROR_MESSAGES,
  classifyApiError,
  parseEndpointForm,
  parseKeyForm,
  parseRevokeForm,
  type ApiErrorCode,
  type CreateState,
} from "./api-access";

/**
 * API key and webhook actions (migration 158). Each runs as the signed-in person; the database checks api.manage and the api_access flag. A new key
 * or webhook secret is returned to the form that asked and shown once there; it is never put in a URL, a cookie or a log.
 */
const PAGE = "/app/settings/api";
const refuse = (code: ApiErrorCode): CreateState => ({ error: API_ERROR_MESSAGES[code], secret: null });

export async function createApiKey(_prev: CreateState, formData: FormData): Promise<CreateState> {
  const v = parseKeyForm(formData);
  if (!v.ok) return refuse(v.code);
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("api_key_create", {
    p_property: v.value.propertyId,
    p_name: v.value.name,
    p_scopes: v.value.scopes,
    p_limit: v.value.limit,
  });
  if (error) return refuse(classifyApiError(error.message));
  revalidatePath(PAGE);
  const key = data && typeof data === "object" && "key" in data ? String((data as { key: unknown }).key) : "";
  return key ? { error: null, secret: { label: "API key", value: key } } : refuse("api_failed");
}

export async function createWebhook(_prev: CreateState, formData: FormData): Promise<CreateState> {
  const v = parseEndpointForm(formData);
  if (!v.ok) return refuse(v.code);
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("webhook_save", {
    p_property: v.value.propertyId,
    p_endpoint: null as unknown as string,
    p_url: v.value.url,
    p_events: v.value.events,
    p_active: v.value.active,
  });
  if (error) return refuse(classifyApiError(error.message));
  revalidatePath(PAGE);
  const secret = data && typeof data === "object" && "secret" in data ? (data as { secret: unknown }).secret : null;
  return typeof secret === "string" ? { error: null, secret: { label: "Signing secret", value: secret } } : refuse("api_failed");
}

export async function saveWebhook(formData: FormData) {
  const v = parseEndpointForm(formData);
  if (!v.ok || !v.value.endpointId) return back(PAGE, { apierr: "api_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("webhook_save", {
    p_property: v.value.propertyId,
    p_endpoint: v.value.endpointId,
    p_url: v.value.url,
    p_events: v.value.events,
    p_active: v.value.active,
  });
  if (error) return back(PAGE, { apierr: classifyApiError(error.message) });
  revalidatePath(PAGE);
  return back(PAGE, { api: "api_saved" });
}

export async function revokeApiKey(formData: FormData) {
  const v = parseRevokeForm(formData);
  if (!v.ok) return back(PAGE, { apierr: "api_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("api_key_revoke", { p_key: v.value.keyId });
  if (error) return back(PAGE, { apierr: classifyApiError(error.message) });
  revalidatePath(PAGE);
  return back(PAGE, { api: "api_revoked" });
}
