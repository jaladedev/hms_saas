import { NewKeyForm, NewWebhookForm } from "@/components/staff/api-create-forms";
import {
  buttonDanger,
  buttonPrimary,
  cardClass,
  EmptyState,
  ErrorBanner,
  inputClass,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { API_SCOPE_LABEL, WEBHOOK_EVENTS, type ApiScope } from "@/lib/api/keys";
import { API_ERROR_MESSAGES, API_OK_MESSAGES, type ApiErrorCode, type ApiOkCode } from "@/lib/staff/api-access";
import { createApiKey, createWebhook, revokeApiKey, saveWebhook } from "@/lib/staff/api-actions";
import { loadApiContext } from "@/lib/staff/api-context";
import { formatDateTime } from "@/lib/staff/format";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * API keys and webhooks (migration 158). Needs api.manage and the api_access plan feature. A key or signing secret is shown once, when it is
 * made, and cannot be shown again; only the first characters of a key are kept for the list. Revoking a key takes effect at once.
 */
export default async function ApiSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property } = await loadApiContext(first(search.property));
  const heading = <PageTitle>API keys and webhooks</PageTitle>;
  if (loadFailed || !property)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">API keys and webhooks are managed by the owner or general manager.</p>
        )}
      </main>
    );
  const [keysQ, callsQ, hooksQ, delQ] = await Promise.all([
    supabase
      .from("api_keys")
      .select("id, name, prefix, scopes, rate_limit_per_minute, created_at, last_used_at, revoked_at")
      .eq("property_id", property.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("api_calls")
      .select("id, key_id, at, method, path, status")
      .eq("property_id", property.id)
      .order("at", { ascending: false })
      .limit(15),
    supabase.from("webhook_endpoints").select("id, url, events, is_active").eq("property_id", property.id).order("created_at"),
    supabase
      .from("webhook_deliveries")
      .select("id, endpoint_id, event, status, attempts, response_code, last_error, created_at")
      .eq("property_id", property.id)
      .order("created_at", { ascending: false })
      .limit(15),
  ]);
  const keys = (keysQ.data ?? []) as Row[];
  const calls = (callsQ.data ?? []) as Row[];
  const hooks = (hooksQ.data ?? []) as Row[];
  const deliveries = (delQ.data ?? []) as Row[];
  const keyName = new Map(keys.map((k) => [s(k.id), s(k.name)]));
  const hookUrl = new Map(hooks.map((h) => [s(h.id), s(h.url)]));
  const err = first(search.apierr);
  const ok = first(search.api);
  const when = (v: unknown) => (s(v) ? formatDateTime(s(v), property.timezone) : "never");

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Let your own website or another system read this hotel&rsquo;s availability and bookings, and be told when a booking changes.
        Requests send the key as <code>Authorization: Bearer &lt;key&gt;</code> to <code>/api/v1/availability</code>,{" "}
        <code>/api/v1/bookings</code> and <code>/api/v1/bookings/&lt;reference&gt;</code>. Webhooks are signed: the{" "}
        <code>Hms-Signature</code> header holds the time and an HMAC-SHA256 of &ldquo;time.body&rdquo; made with the signing secret. Webhook
        bodies carry the booking reference, status and dates only. Creating bookings through the API is not available yet. API access must
        be in your hotel group&rsquo;s plan.
      </PageIntro>
      <div className="mt-5">
        {err && err in API_ERROR_MESSAGES && <ErrorBanner className="mb-5">{API_ERROR_MESSAGES[err as ApiErrorCode]}</ErrorBanner>}
        {ok && ok in API_OK_MESSAGES && (
          <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
            {API_OK_MESSAGES[ok as ApiOkCode]}
          </p>
        )}
      </div>
      {(keysQ.error || hooksQ.error) && <ErrorBanner className="mb-5">Some details could not be loaded. Reload the page.</ErrorBanner>}

      <section aria-label="API keys">
        <SectionTitle>API keys</SectionTitle>
        <div className={`${cardClass} mt-3`}>
          <NewKeyForm propertyId={property.id} action={createApiKey} />
        </div>
        {keys.length === 0 ? (
          <EmptyState className="mt-3">No keys yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {keys.map((k) => (
              <li key={s(k.id)} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {s(k.name)} <code className="text-xs font-normal text-muted">hms_{s(k.prefix)}…</code>
                  </p>
                  <p className="text-sm">{k.revoked_at ? <strong>Revoked</strong> : "Live"}</p>
                </div>
                <p className="text-xs text-muted">
                  {list(k.scopes)
                    .map((x) => API_SCOPE_LABEL[x as ApiScope] ?? x)
                    .join("; ")}{" "}
                  · {String(k.rate_limit_per_minute)} calls a minute · last used {when(k.last_used_at)}
                </p>
                {!k.revoked_at && (
                  <form action={revokeApiKey} className="mt-2">
                    <input type="hidden" name="keyId" value={s(k.id)} />
                    <PendingButton className={buttonDanger}>Revoke</PendingButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {calls.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer">Latest calls</summary>
            <ul className="mt-2 grid gap-1">
              {calls.map((c) => (
                <li key={String(c.id)} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                  <span>
                    {s(c.method)} {s(c.path)} · {keyName.get(s(c.key_id)) ?? "key"}
                  </span>
                  <span className="text-muted">
                    {String(c.status)} · {when(c.at)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="mt-10" aria-label="Webhooks">
        <SectionTitle>Webhook addresses</SectionTitle>
        <div className={`${cardClass} mt-3`}>
          <NewWebhookForm propertyId={property.id} action={createWebhook} />
        </div>
        <ul className="mt-3 grid gap-2">
          {hooks.map((h) => (
            <li key={s(h.id)} className={cardClass}>
              <form action={saveWebhook} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="propertyId" value={property.id} />
                <input type="hidden" name="endpointId" value={s(h.id)} />
                <label className="block text-xs" htmlFor={`u-${s(h.id)}`}>
                  Address
                  <input
                    id={`u-${s(h.id)}`}
                    name="url"
                    required
                    maxLength={200}
                    defaultValue={s(h.url)}
                    className={`${inputClass} mt-1 w-80`}
                  />
                </label>
                <fieldset className="text-xs">
                  <legend>Events</legend>
                  <div className="mt-1 flex flex-wrap gap-3 text-sm">
                    {WEBHOOK_EVENTS.map((e) => (
                      <label key={e} className="flex items-center gap-1">
                        <input type="checkbox" name="event" value={e} defaultChecked={list(h.events).includes(e)} /> {e}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="active" defaultChecked={h.is_active === true} /> On
                </label>
                <PendingButton className={buttonPrimary}>Save</PendingButton>
              </form>
            </li>
          ))}
        </ul>
        {deliveries.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer">Latest deliveries</summary>
            <ul className="mt-2 grid gap-1">
              {deliveries.map((d) => (
                <li key={s(d.id)} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                  <span>
                    {s(d.event)} → {hookUrl.get(s(d.endpoint_id)) ?? "address"}
                  </span>
                  <span className="text-muted">
                    {s(d.status)}
                    {d.response_code ? ` (${String(d.response_code)})` : ""}
                    {s(d.last_error) ? ` · ${s(d.last_error)}` : ""} · {String(d.attempts)} {Number(d.attempts) === 1 ? "try" : "tries"} ·{" "}
                    {when(d.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </main>
  );
}
