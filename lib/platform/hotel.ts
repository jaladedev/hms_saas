/**
 * Rules and wording for platform administration. Pure functions, tested without a server. They mirror the checks in
 * migration 050 so a person gets a plain message, but the database decides: nothing here is a permission.
 */

export type NewHotelInput = {
  name: string;
  slug: string;
  propertyName: string;
  propertyCode: string;
  city: string;
  state: string;
  timezone: string;
  currency: string;
  host: string;
  ownerEmail: string;
  secretReference: string;
  paymentMode: "test" | "live";
};

export type NewHotelField =
  | "name"
  | "slug"
  | "property_name"
  | "code"
  | "timezone"
  | "currency"
  | "host"
  | "owner_email"
  | "secret_reference"
  | "payment_mode";

const SLUG = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const CODE = /^[A-Z0-9-]{2,12}$/;
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SECRET_REF = /^env:[A-Z][A-Z0-9_]{2,60}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const squash = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/** "Hotel Ibadan & Suites" -> "hotel-ibadan-suites". Used when the slug box is left empty. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

/** What a person pastes ("https://Book.Hotel.com:443/path") reduced to the host the guest site is reached on. */
export function normalizeHost(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  return v;
}

/** A secret reference may be typed as the bare variable name; the app stores "env:NAME". */
export function normalizeSecretReference(value: string): string {
  const v = value.trim();
  if (v === "") return "";
  return v.startsWith("env:") ? v : `env:${v}`;
}

export function validateNewHotel(raw: Record<string, unknown>): { ok: true; value: NewHotelInput } | { ok: false; field: NewHotelField } {
  const name = squash(raw.name);
  const propertyName = squash(raw.propertyName);
  if (name === "" || name.length > 120) return { ok: false, field: "name" };
  if (propertyName === "" || propertyName.length > 120) return { ok: false, field: "property_name" };
  const slug = squash(raw.slug).toLowerCase() || slugFromName(name);
  if (!SLUG.test(slug)) return { ok: false, field: "slug" };
  const propertyCode = squash(raw.propertyCode).toUpperCase();
  if (!CODE.test(propertyCode)) return { ok: false, field: "code" };
  const timezone = squash(raw.timezone) || "Africa/Lagos";
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(timezone)) return { ok: false, field: "timezone" };
  const currency = (squash(raw.currency) || "NGN").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, field: "currency" };
  const host = normalizeHost(typeof raw.host === "string" ? raw.host : "");
  if (host.length > 253 || !HOST.test(host)) return { ok: false, field: "host" };
  const ownerEmail = squash(raw.ownerEmail).toLowerCase();
  if (ownerEmail.length > 254 || !EMAIL.test(ownerEmail)) return { ok: false, field: "owner_email" };
  const secretReference = normalizeSecretReference(typeof raw.secretReference === "string" ? raw.secretReference : "");
  if (secretReference !== "" && !SECRET_REF.test(secretReference)) return { ok: false, field: "secret_reference" };
  const paymentMode =
    raw.paymentMode === "live"
      ? "live"
      : raw.paymentMode === "test" || raw.paymentMode === undefined || raw.paymentMode === ""
        ? "test"
        : null;
  if (paymentMode === null) return { ok: false, field: "payment_mode" };
  return {
    ok: true,
    value: {
      name,
      slug,
      propertyName,
      propertyCode,
      city: squash(raw.city),
      state: squash(raw.state),
      timezone,
      currency,
      host,
      ownerEmail,
      secretReference,
      paymentMode,
    },
  };
}

/** Wording for the field that failed validation. */
export const FIELD_MESSAGES: Record<NewHotelField, string> = {
  name: "Enter the hotel group's name (up to 120 characters).",
  slug: "The short name must be 3 to 63 lowercase letters, digits or hyphens, and cannot start or end with a hyphen.",
  property_name: "Enter the first property's name (up to 120 characters).",
  code: "The property code must be 2 to 12 capital letters, digits or hyphens. It cannot be changed later.",
  timezone: "Enter a time zone such as Africa/Lagos.",
  currency: "Enter a three-letter currency such as NGN.",
  host: "Enter the web address guests will use, such as book.example.com.",
  owner_email: "Enter the owner's email address.",
  secret_reference:
    "The payment secret name must be capitals, digits and underscores, starting with a letter (for example PAYSTACK_SECRET_HOTEL).",
  payment_mode: "Choose test or live.",
};

export type PlatformCode =
  | "forbidden"
  | "not_found"
  | "slug"
  | "code"
  | "name"
  | "host"
  | "timezone"
  | "currency"
  | "secret_reference"
  | "payment_mode"
  | "owner_missing"
  | "slug_taken"
  | "host_taken"
  | "property"
  | "reason"
  | "status"
  | "invite_failed"
  | "owner_active"
  | "plan"
  | "plan_details"
  | "invoice_details"
  | "invoice_exists"
  | "invoice_state"
  | "ticket_details"
  | "access_details"
  | "access_open"
  | "access_state"
  | "access_own"
  | "subscription_status"
  | "feature_key"
  | "bad_request"
  | "unavailable";

/** Which refusal a failed call means. The database's own words are never shown to the person. */
export function classifyPlatformError(err: { code?: string; message?: string } | null | undefined): PlatformCode {
  const m = err?.message ?? "";
  if (/^NOT_FOUND: owner/.test(m)) return "owner_missing";
  if (/^NOT_FOUND: property/.test(m)) return "property";
  if (/^NOT_FOUND/.test(m)) return "not_found";
  if (/^CONFLICT: slug/.test(m)) return "slug_taken";
  if (/^CONFLICT: host/.test(m)) return "host_taken";
  if (/^CONFLICT: invoice period/.test(m)) return "invoice_exists";
  if (/^CONFLICT: invoice state/.test(m)) return "invoice_state";
  if (/^CONFLICT: access open/.test(m)) return "access_open";
  if (/^CONFLICT: access state/.test(m)) return "access_state";
  if (/^POLICY_VIOLATION: access own request/.test(m)) return "access_own";
  const v = /^POLICY_VIOLATION: (.+)$/.exec(m)?.[1]?.trim();
  switch (v) {
    case "slug":
    case "code":
    case "name":
    case "host":
    case "timezone":
    case "currency":
    case "reason":
    case "status":
      return v;
    case "secret reference":
      return "secret_reference";
    case "payment mode":
      return "payment_mode";
    case "plan":
    case "plan code":
      return "plan";
    case "ticket title":
    case "ticket details":
    case "ticket priority":
    case "ticket note":
    case "ticket status":
      return "ticket_details";
    case "access reason":
    case "access hours":
    case "access ticket":
    case "access decision":
    case "access note":
    case "access status":
      return "access_details";
    case "invoice period":
    case "invoice due":
    case "invoice note":
    case "invoice amount":
    case "invoice reference":
    case "invoice reason":
      return "invoice_details";
    case "plan name":
    case "plan description":
    case "plan price":
    case "plan active":
    case "plan features":
      return "plan_details";
    case "subscription status":
      return "subscription_status";
    case "feature key":
      return "feature_key";
    case "verified":
    case "enabled":
      return "bad_request";
    default:
      break;
  }
  if (err?.code === "42501") return "forbidden";
  if (/^FORBIDDEN/.test(m)) return "forbidden";
  return "unavailable";
}

export const ERROR_MESSAGES: Record<PlatformCode, string> = {
  forbidden: "You do not have permission to do that.",
  not_found: "That hotel group was not found.",
  slug: FIELD_MESSAGES.slug,
  code: FIELD_MESSAGES.code,
  name: "Enter a name (up to 120 characters).",
  host: FIELD_MESSAGES.host,
  timezone: "That time zone is not known. Use a name such as Africa/Lagos.",
  currency: FIELD_MESSAGES.currency,
  secret_reference: FIELD_MESSAGES.secret_reference,
  payment_mode: FIELD_MESSAGES.payment_mode,
  owner_missing: "The owner's login could not be found or created. Nothing was set up.",
  slug_taken: "Another hotel group already uses that short name.",
  host_taken: "That web address is already in use.",
  property: "That property does not belong to this hotel group.",
  reason: "Give a reason of at least 3 characters.",
  status: "That is not a valid status.",
  owner_active: "That owner has already accepted their invitation.",
  plan: "The plan code must be 2 to 40 lowercase letters, digits, hyphens or underscores, such as starter.",
  plan_details:
    "Check the plan: a name of 2 to 60 characters, a description up to 300, a price of zero or more, and feature keys made of lowercase letters, digits, dots or underscores.",
  invoice_details:
    "Check the invoice: the period must end after it starts (and be under 400 days), the amount must be above zero (or the group needs a plan with a decided price), paying needs a reference, and voiding needs a reason of at least 3 characters.",
  invoice_exists: "That period already has an invoice. Void it first if it has to be raised again.",
  ticket_details:
    "Check the ticket: a title of 3 to 120 characters, details up to 2,000, a note of 1 to 1,000, and a priority and status from the lists.",
  access_details:
    "Check the request: a reason of 10 to 500 characters, 1, 4 or 24 hours, and a ticket that belongs to the same hotel group. A decision note can be up to 300 characters.",
  access_open: "You already have a request open for that hotel group. Wait for it, or end it first.",
  access_state: "That request has already been decided, ended or has run out. Ask again if you still need to look.",
  access_own: "Another admin has to decide your request.",
  invoice_state: "A paid invoice cannot be voided, and a void one cannot be paid.",
  subscription_status: "Choose trial, active, past due or cancelled.",
  feature_key: "The feature key must be 2 to 60 characters: lowercase letters, digits, dots or underscores, starting with a letter.",
  invite_failed: "The owner's invitation could not be sent. Nothing was set up. Try again in a moment.",
  bad_request: "That request was not valid. Check the form and try again.",
  unavailable: "That could not be done right now. Try again in a moment.",
};

export type PlatformOk =
  | "created"
  | "status"
  | "domain_added"
  | "domain_verified"
  | "domain_unverified"
  | "provider"
  | "invite_resent"
  | "plan_set"
  | "plan_saved"
  | "plan_applied"
  | "invoice_raised"
  | "invoice_paid"
  | "invoice_voided"
  | "ticket_opened"
  | "ticket_note_added"
  | "ticket_status_set"
  | "access_requested"
  | "access_approved"
  | "access_denied"
  | "access_ended"
  | "feature_set"
  | "unchanged";
export const OK_MESSAGES: Record<PlatformOk, string> = {
  created: "Hotel group created. Its domain is not verified yet, so guests cannot reach it until you verify the address.",
  status: "Status changed.",
  domain_added: "Web address added. It is not verified yet.",
  domain_verified: "Web address verified. The guest site now answers on it.",
  domain_unverified: "Web address marked unverified. The guest site no longer answers on it.",
  provider: "Payment account status changed.",
  invite_resent: "Invitation sent again.",
  plan_set: "Plan saved.",
  plan_saved: "Plan saved in the catalog.",
  invoice_raised: "Invoice raised.",
  invoice_paid: "Invoice marked paid.",
  invoice_voided: "Invoice voided.",
  ticket_opened: "Ticket opened.",
  ticket_note_added: "Note added.",
  ticket_status_set: "Ticket status changed.",
  access_requested: "Request sent. An admin other than you has to approve it before you can look.",
  access_approved: "Approved. The person who asked can now open the hotel's setup until the time runs out.",
  access_denied: "Request denied.",
  access_ended: "Access ended.",
  plan_applied: "Plan applied: the group's plan and its feature flags now follow it.",
  feature_set: "Feature flag saved.",
  unchanged: "Nothing changed: it was already like that.",
};

export const isPlatformOk = (v: string | undefined): v is PlatformOk => v !== undefined && v in OK_MESSAGES;
export const isPlatformCode = (v: string | undefined): v is PlatformCode => v !== undefined && v in ERROR_MESSAGES;

/** A date and time for a table, in the viewer's neutral form (UTC), so the page needs no time zone of its own. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}

/** "35,000" or "35000.50" typed in naira to whole kobo; null for anything that is not a plain amount of zero or more. */
export function parseNairaToKobo(value: string): number | null {
  const v = value.trim().replace(/[,\s]/g, "").replace(/^₦/, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

/** "NGN 35,000" style label for a monthly price; a placeholder price is marked so nobody reads it as decided. */
export function planPriceLabel(minor: number, currency: string, placeholder: boolean): string {
  const amount = new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(minor / 100);
  return `${amount} a month${placeholder ? " (placeholder)" : ""}`;
}

// ---- finding hotels, and the entitlements grid -----------------------------------------------------------------------------------

export type HotelListRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan_code: string | null;
  subscription_status: string | null;
};

/** Hotels whose name, slug or plan code contains every word typed (any case), optionally only one status. Blank means all. */
export function filterHotels<T extends HotelListRow>(rows: T[], q: string | undefined, status?: string): T[] {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (status && r.status !== status) return false;
    const hay = `${r.name} ${r.slug} ${r.plan_code ?? ""} ${r.subscription_status ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type EntitlementOverview = {
  enforced: string[];
  hotels: (HotelListRow & { entitlements: { feature_key: string; enabled: boolean }[] })[];
};

/** "on" or "off" is a row an admin set; "default-on" an enforced flag with no row (works); "unset" any other key with no row. */
export type FlagCell = "on" | "off" | "default-on" | "unset";

export function flagCell(entitlements: { feature_key: string; enabled: boolean }[], key: string, enforced: string[]): FlagCell {
  const row = entitlements.find((e) => e.feature_key === key);
  if (row) return row.enabled ? "on" : "off";
  return enforced.includes(key) ? "default-on" : "unset";
}

/** The columns of the grid: the enforced flags first (in the platform's order), then any other key some hotel has, sorted. */
export function gridKeys(o: EntitlementOverview): string[] {
  const extra = new Set<string>();
  for (const h of o.hotels) for (const e of h.entitlements) if (!o.enforced.includes(e.feature_key)) extra.add(e.feature_key);
  return [...o.enforced, ...[...extra].sort()];
}

/** Reads the overview defensively: anything that is not the expected shape becomes an empty overview. */
export function readOverview(raw: unknown): EntitlementOverview {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const enforced = Array.isArray(o.enforced) ? o.enforced.filter((k): k is string => typeof k === "string") : [];
  const hotels = Array.isArray(o.hotels) ? (o.hotels as EntitlementOverview["hotels"]) : [];
  return { enforced, hotels: hotels.map((h) => ({ ...h, entitlements: Array.isArray(h.entitlements) ? h.entitlements : [] })) };
}
