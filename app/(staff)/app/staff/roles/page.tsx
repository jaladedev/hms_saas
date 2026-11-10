import Link from "next/link";
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  EmptyState,
  ErrorBanner,
  inputClass,
  linkClass,
  Notice,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PERMISSION_GROUPS, parseCustomRoles, roleSummary, type CustomRole } from "@/lib/staff/custom-roles";
import { createRole, deleteRole, updateRole } from "@/lib/staff/role-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function PermissionBoxes({ chosen }: { chosen: string[] }) {
  return (
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {PERMISSION_GROUPS.map((g) => (
        <fieldset key={g.title}>
          <legend className="text-sm font-medium">{g.title}</legend>
          <div className="mt-1 space-y-1">
            {g.items.map((i) => (
              <label key={i.key} className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="permission" value={i.key} defaultChecked={chosen.includes(i.key)} className="mt-1" />
                <span>{i.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export default async function CustomRolesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [dirQ, tenantQ] = await Promise.all([supabase.rpc("staff_directory"), supabase.from("tenants").select("id, name").order("name")]);
  // A failed lookup is not the same as "you own no group": say so, instead of telling an owner to ask an owner.
  if (dirQ.error || tenantQ.error) {
    return (
      <main className="max-w-3xl">
        <PageTitle>Custom roles</PageTitle>
        <ErrorBanner className="mt-4">The roles could not be loaded. Reload the page.</ErrorBanner>
      </main>
    );
  }
  const memberTenants = new Set(((dirQ.data ?? []) as { tenant_id: string }[]).map((m) => m.tenant_id));
  const tenants = ((tenantQ.data ?? []) as { id: string; name: string }[]).filter((t) => memberTenants.has(t.id));
  const lists = await Promise.all(
    tenants.map(async (t) => {
      const q = await supabase.rpc("custom_roles_list", { p_tenant: t.id });
      return { tenant: t, roles: parseCustomRoles(q.data), failed: Boolean(q.error) };
    }),
  );

  if (tenants.length === 0) {
    return (
      <main className="max-w-3xl">
        <PageTitle>Custom roles</PageTitle>
        <EmptyState className="mt-4">Only a hotel owner can create roles. If you need one, ask an owner.</EmptyState>
      </main>
    );
  }

  return (
    <main className="max-w-4xl">
      <PageTitle>Custom roles</PageTitle>
      <PageIntro>
        Make a role for a job the built-in ones do not fit, such as a night auditor. Pick exactly what it may do, then give it to people
        from the{" "}
        <Link href="/app/staff" className={linkClass}>
          Staff page
        </Link>
        . A role cannot manage staff, and it cannot both request and approve refunds. Changing a role applies at once to everyone who holds
        it.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {lists.map(({ tenant, roles, failed }) => (
        <section key={tenant.id} className="mt-8" aria-labelledby={`g-${tenant.id}`}>
          {tenants.length > 1 && <SectionTitle id={`g-${tenant.id}`}>{tenant.name}</SectionTitle>}
          {failed ? (
            <ErrorBanner className="mt-3">This group's roles could not be loaded. Reload the page.</ErrorBanner>
          ) : roles.length === 0 ? (
            <EmptyState className="mt-3">No custom roles yet.</EmptyState>
          ) : (
            <ul className="mt-3 border-t border-line">
              {roles.map((r: CustomRole) => (
                <li key={r.id} className="border-b border-line py-4">
                  <details>
                    <summary className="cursor-pointer">
                      <span className="font-medium">{r.name}</span> <span className="text-sm text-muted">{roleSummary(r)}</span>
                    </summary>
                    <form action={updateRole} className="mt-4 space-y-4">
                      <input type="hidden" name="roleId" value={r.id} />
                      <div>
                        <label htmlFor={`n-${r.id}`} className="block text-sm font-medium">
                          Name
                        </label>
                        <input
                          id={`n-${r.id}`}
                          name="name"
                          required
                          minLength={2}
                          maxLength={60}
                          defaultValue={r.name}
                          className={inputClass}
                        />
                      </div>
                      <PermissionBoxes chosen={r.permissions} />
                      <button type="submit" className={buttonQuiet}>
                        Save changes
                      </button>
                    </form>
                    <form action={deleteRole} className="mt-3">
                      <input type="hidden" name="roleId" value={r.id} />
                      <button
                        type="submit"
                        className={buttonDanger}
                        disabled={r.holders > 0}
                        title={r.holders > 0 ? "Remove it from the people who hold it first" : undefined}
                      >
                        Delete role
                      </button>
                    </form>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-6 border-y border-line py-4">
            <summary className="cursor-pointer text-sm font-medium text-primary-strong">New role</summary>
            <form action={createRole} className="mt-4 space-y-4">
              <input type="hidden" name="tenantId" value={tenant.id} />
              <div>
                <label htmlFor={`new-${tenant.id}`} className="block text-sm font-medium">
                  Name
                </label>
                <input id={`new-${tenant.id}`} name="name" required minLength={2} maxLength={60} className={inputClass} />
              </div>
              <PermissionBoxes chosen={[]} />
              <button type="submit" className={buttonPrimary}>
                Create role
              </button>
            </form>
          </details>
        </section>
      ))}
    </main>
  );
}
