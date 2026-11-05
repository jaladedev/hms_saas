import Link from "next/link";
import { buttonPrimary, buttonQuiet, inputClass, ErrorBanner, EmptyState, PageIntro } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import {
  actionsFor, actorName, AUDIT_COLUMNS, collectIds, describeEvent, HISTORY_FILTERS, historyQuery, PAGE_SIZE, parseHistoryFilters,
  type AuditRow, type Format, type Lookup,
} from "@/lib/staff/setup-history";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Setup history: who changed the hotel's room types, rooms, rates, tax rules, policies and staff access, and what changed.
 * Reads audit_logs as the signed-in person. The table shows a row only to people with audit.view at its property
 * (row-level security), so this page never decides who may see what; a login without it gets an empty explanation.
 * Names of the things changed come from the live tables by id, names of the people from audit_actor_names (029).
 * Staff status changes (suspend, reinstate, remove) apply to the whole hotel group and are written without a
 * property; migration 030 lets people with audit.view see those membership rows, and they are listed here under
 * "All properties" only, so choosing one property leaves them out.
 */
export default async function SetupHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const f = parseHistoryFilters(search);
  const supabase = await createClient();

  const { data: propData, error: propError } = await supabase.from("properties").select("id, name, timezone").order("name");
  const properties = (propData ?? []) as { id: string; name: string; timezone: string }[];
  const viewable = (await Promise.all(properties.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "audit.view" });
    return data === true ? p : null;
  }))).filter((p): p is (typeof properties)[number] => p !== null);
  const many = viewable.length > 1;
  const property = f.property && viewable.some((p) => p.id === f.property) ? f.property : null;
  const filters = { ...f, property };

  if (viewable.length === 0) {
    return (
      <main className="max-w-3xl">
        <h1 className="font-display text-3xl">Setup history</h1>
        {propError
          ? <ErrorBanner className="mt-4">The history could not be loaded. Reload the page.</ErrorBanner>
          : <EmptyState className="mt-4">Only people who may view the audit trail, such as the owner and the general manager, can see who changed the hotel&apos;s setup. Ask one of them if you need to know.</EmptyState>}
      </main>
    );
  }

  const offset = (f.page - 1) * PAGE_SIZE;
  // Staff access changes (suspend, reinstate, remove) belong to the whole hotel group and have no property (migration 030
  // lets audit.view readers see them), so they are listed only when no single property is chosen.
  const propertyIds = viewable.map((p) => p.id).join(",");
  const query = supabase.from("audit_logs").select(AUDIT_COLUMNS)
    .or(property ? `property_id.eq.${property}` : `property_id.in.(${propertyIds}),and(property_id.is.null,entity_type.eq.membership)`)
    .in("action", actionsFor(f.what)).order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + PAGE_SIZE);
  const { data: logData, error: logError } = await query;
  const fetched = (logData ?? []) as AuditRow[];
  const hasNext = fetched.length > PAGE_SIZE;
  const rows = fetched.slice(0, PAGE_SIZE);

  const ids = collectIds(rows);
  const [typeQ, roomQ, planQ, taxQ, roleQ, peopleQ] = await Promise.all([
    ids.roomTypes.length ? supabase.from("room_types").select("id, name").in("id", ids.roomTypes) : null,
    ids.rooms.length ? supabase.from("rooms").select("id, room_number").in("id", ids.rooms) : null,
    ids.ratePlans.length ? supabase.from("rate_plans").select("id, name").in("id", ids.ratePlans) : null,
    ids.taxRules.length ? supabase.from("tax_rules").select("id, name, basis").in("id", ids.taxRules) : null,
    rows.some((r) => r.entity_type === "membership") ? supabase.from("roles").select("key, name") : null,
    ids.users.length ? supabase.rpc("audit_actor_names", { p_user_ids: ids.users }) : null,
  ]);
  const lookup: Lookup = {
    roomTypes: new Map(((typeQ?.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name])),
    rooms: new Map(((roomQ?.data ?? []) as { id: string; room_number: string }[]).map((r) => [r.id, r.room_number])),
    ratePlans: new Map(((planQ?.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name])),
    taxRules: new Map(((taxQ?.data ?? []) as { id: string; name: string; basis: string }[]).map((r) => [r.id, { name: r.name, basis: r.basis }])),
    people: new Map(((peopleQ?.data ?? []) as { user_id: string; name: string | null }[]).filter((r) => r.name).map((r) => [r.user_id, r.name as string])),
    roles: new Map(((roleQ?.data ?? []) as { key: string; name: string }[]).map((r) => [r.key, r.name])),
    properties: new Map(properties.map((p) => [p.id, p.name])),
  };
  const fmt: Format = { money: (m) => formatMoney(m, "NGN"), date: formatDate };
  const zone = new Map(properties.map((p) => [p.id, p.timezone]));

  return (
    <main className="max-w-4xl">
      <h1 className="font-display text-3xl">Setup history</h1>
      <PageIntro>
        Who changed the hotel&apos;s room types, rooms, rates, tax rules, policies and staff access, newest first. Each line says who made the change and what it was; edits show the old and the new value. Nothing here can be changed or deleted.
      </PageIntro>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-4" aria-label="Filter the history">
        {many && (
          <div>
            <label htmlFor="h-property" className="block text-sm">Property</label>
            <select id="h-property" name="property" defaultValue={property ?? ""} className={inputClass}>
              <option value="">All properties</option>
              {viewable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="h-what" className="block text-sm">Show</label>
          <select id="h-what" name="what" defaultValue={f.what} className={inputClass}>
            {HISTORY_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button type="submit" className={buttonPrimary}>Show</button>
      </form>

      {property && many && (f.what === "all" || f.what === "staff") && (
        <p className="mt-3 text-sm text-muted">Suspensions, reinstatements and removals apply to the whole hotel group, so they show under All properties.</p>
      )}

      {logError && <ErrorBanner className="mt-6">The history could not be loaded. Reload the page.</ErrorBanner>}

      {!logError && rows.length === 0 && (
        <EmptyState className="mt-6">
          {f.page > 1 ? "There is nothing further back." : "Nothing has been recorded for this selection yet."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ol className="mt-6 divide-y divide-line border-y border-line">
          {rows.map((r) => {
            const { summary, details } = describeEvent(r, lookup, fmt);
            const where = r.property_id ? lookup.properties.get(r.property_id) : null;
            return (
              <li key={r.id} className="py-4">
                <p className="font-medium">{summary}</p>
                <p className="mt-1 text-sm text-muted">
                  <span className="tabular-nums">{formatDateTime(r.created_at, (r.property_id && zone.get(r.property_id)) || viewable[0]?.timezone || "UTC")}</span>
                  {" \u00b7 "}{actorName(r, lookup.people)}{many && where ? ` \u00b7 ${where}` : ""}
                </p>
                {details.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-sm">
                    {details.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {(f.page > 1 || hasNext) && (
        <nav aria-label="Pages" className="mt-6 flex items-center gap-4 text-sm">
          {f.page > 1 ? <Link href={`/app/settings/history${historyQuery(filters, { page: f.page - 1 })}`} className={buttonQuiet} rel="prev">Newer</Link> : <span />}
          <span className="text-muted">Page {f.page}</span>
          {hasNext ? <Link href={`/app/settings/history${historyQuery(filters, { page: f.page + 1 })}`} className={buttonQuiet} rel="next">Older</Link> : <span />}
        </nav>
      )}
    </main>
  );
}
