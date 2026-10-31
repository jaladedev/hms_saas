import { buttonDanger, buttonPrimary, buttonQuiet, inputClass, MemberStatusChip, Notice } from "@/components/staff/ui";
import { addStaffRole, inviteStaff, removeStaffRole, setStaffStatus } from "@/lib/staff/staff-actions";
import { memberActions, memberLabel, ROLE_HELP, scopeLabel, type Member } from "@/lib/staff/staff-rules";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function StaffPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [dirQ, propQ, tenantQ, roleQ] = await Promise.all([
    supabase.rpc("staff_directory"),
    supabase.from("properties").select("id, tenant_id, name").order("name"),
    supabase.from("tenants").select("id, name").order("name"),
    supabase.from("roles").select("key, name").order("name"),
  ]);
  const members = (dirQ.data ?? []) as Member[];
  const properties = (propQ.data ?? []) as { id: string; tenant_id: string; name: string }[];
  const tenants = (tenantQ.data ?? []) as { id: string; name: string }[];
  const roles = (roleQ.data ?? []) as { key: string; name: string }[];
  const propName = new Map(properties.map((p) => [p.id, p.name]));
  const managedTenants = tenants.filter((t) => members.some((m) => m.tenant_id === t.id));
  const manyTenants = managedTenants.length > 1;
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
  const current = members.filter((m) => m.status !== "revoked");
  const former = members.filter((m) => m.status === "revoked");

  if (!dirQ.error && members.length === 0) {
    return (
      <main className="max-w-3xl">
        <h1 className="font-display text-3xl">Staff & permissions</h1>
        <p className="mt-4 rounded border border-line bg-white px-4 py-6 text-muted">Only a hotel owner can manage staff. If you need someone added or changed, ask an owner.</p>
      </main>
    );
  }

  function RoleSelect({ id }: { id: string }) {
    return (
      <select id={id} name="roleKey" required defaultValue="" className={inputClass}>
        <option value="" disabled>Choose a role</option>
        {roles.map((r) => <option key={r.key} value={r.key}>{r.name}{ROLE_HELP[r.key] ? `: ${ROLE_HELP[r.key]}` : ""}</option>)}
      </select>
    );
  }
  function PropertySelect({ id, tenantId }: { id: string; tenantId: string }) {
    return (
      <select id={id} name="propertyId" defaultValue="" className={inputClass}>
        <option value="">All properties</option>
        {properties.filter((p) => !tenantId || p.tenant_id === tenantId).map((p) => <option key={p.id} value={p.id}>Only {p.name}</option>)}
      </select>
    );
  }

  function Row({ m }: { m: Member }) {
    const act = memberActions(m);
    return (
      <li className="grid gap-x-8 gap-y-3 border-b border-line py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{memberLabel(m)}</span>
            <MemberStatusChip status={m.status} />
            {m.is_self && <span className="text-sm text-muted">You</span>}
            {manyTenants && <span className="text-xs text-muted">{tenantName.get(m.tenant_id)}</span>}
          </p>
          {m.full_name && m.email && <p className="text-sm text-muted">{m.email}</p>}
          {m.roles.length === 0 ? <p className="mt-2 text-sm text-muted">{m.status === "revoked" ? "No access." : "No roles, so no access to anything."}</p> : (
            <ul className="mt-2 space-y-1">
              {m.roles.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 text-sm">
                  <span><span className="font-medium">{r.role_name}</span>, {scopeLabel(r.property_id, propName)}</span>
                  {act.removeRole && (
                    <form action={removeStaffRole}>
                      <input type="hidden" name="membershipRoleId" value={r.id} />
                      <button type="submit" className="text-sm text-critical underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-critical">Remove</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3 md:justify-self-end">
          {act.addRole && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-primary-strong">Add a role</summary>
              <form action={addStaffRole} className="mt-3 space-y-3">
                <input type="hidden" name="tenantId" value={m.tenant_id} />
                <input type="hidden" name="userId" value={m.user_id} />
                <div><label htmlFor={`r-${m.membership_id}`} className="block text-sm">Role</label><RoleSelect id={`r-${m.membership_id}`} /></div>
                <div><label htmlFor={`p-${m.membership_id}`} className="block text-sm">Where</label><PropertySelect id={`p-${m.membership_id}`} tenantId={m.tenant_id} /></div>
                <button type="submit" className={buttonQuiet}>Add role</button>
              </form>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {act.suspend && (
              <form action={setStaffStatus}>
                <input type="hidden" name="membershipId" value={m.membership_id} /><input type="hidden" name="status" value="suspended" />
                <button type="submit" className={buttonQuiet}>Suspend</button>
              </form>
            )}
            {act.reinstate && (
              <form action={setStaffStatus}>
                <input type="hidden" name="membershipId" value={m.membership_id} /><input type="hidden" name="status" value="active" />
                <button type="submit" className={buttonPrimary}>Restore access</button>
              </form>
            )}
          </div>
          {act.revoke && (
            <details>
              <summary className="cursor-pointer text-sm text-critical">Remove from the hotel</summary>
              <form action={setStaffStatus} className="mt-3 space-y-2">
                <input type="hidden" name="membershipId" value={m.membership_id} /><input type="hidden" name="status" value="revoked" />
                <p className="max-w-xs text-xs text-muted">Ends their access and clears all their roles. It cannot be undone; to bring them back, add them again.</p>
                <button type="submit" className={buttonDanger}>Remove {memberLabel(m)}</button>
              </form>
            </details>
          )}
        </div>
      </li>
    );
  }

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Staff & permissions</h1>
      <p className="mt-2 max-w-prose text-muted">
        Who can sign in, and what each person can do. Changes take effect on their next action. Everything here is recorded in the audit log.
      </p>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
        {dirQ.error && <p role="alert" className="mb-5 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The staff list could not be loaded. Reload the page.</p>}
      </div>

      <section aria-labelledby="invite" className="border-y border-line py-6">
        <h2 id="invite" className="font-display text-xl">Add someone</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          New people get an email with a link to choose a password. Someone who already has an account just gets the new access. You can only give roles whose permissions you hold yourself.
        </p>
        <form action={inviteStaff} className="mt-4 grid max-w-2xl gap-4 md:grid-cols-2">
          {manyTenants ? (
            <div className="md:col-span-2">
              <label htmlFor="inv-tenant" className="block text-sm font-medium">Hotel group</label>
              <select id="inv-tenant" name="tenantId" required className={inputClass}>{managedTenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </div>
          ) : <input type="hidden" name="tenantId" value={managedTenants[0]?.id ?? members[0]?.tenant_id ?? ""} />}
          <div className="md:col-span-2">
            <label htmlFor="inv-email" className="block text-sm font-medium">Email</label>
            <input id="inv-email" name="email" type="email" required maxLength={254} autoCapitalize="none" spellCheck={false} autoComplete="off" className={inputClass} />
          </div>
          <div><label htmlFor="inv-role" className="block text-sm font-medium">Role</label><RoleSelect id="inv-role" /></div>
          <div><label htmlFor="inv-prop" className="block text-sm font-medium">Where</label><PropertySelect id="inv-prop" tenantId={manyTenants ? "" : managedTenants[0]?.id ?? members[0]?.tenant_id ?? ""} /></div>
          <div className="md:col-span-2"><button type="submit" className={buttonPrimary}>Send invitation</button></div>
        </form>
      </section>

      <section className="mt-10" aria-labelledby="current">
        <h2 id="current" className="font-display text-xl">Staff <span className="text-base text-muted">({current.length})</span></h2>
        <ul className="mt-2 border-t border-line">{current.map((m) => <Row key={m.membership_id} m={m} />)}</ul>
      </section>

      {former.length > 0 && (
        <section className="mt-10" aria-labelledby="former">
          <h2 id="former" className="font-display text-xl text-muted">Former staff <span className="text-base">({former.length})</span></h2>
          <ul className="mt-2 border-t border-line">{former.map((m) => <Row key={m.membership_id} m={m} />)}</ul>
        </section>
      )}
    </main>
  );
}
