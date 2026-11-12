import { buttonPrimary, inputClass, Notice, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/staff/auth";
import { DENSITIES, describeRoles, groupPermissions, parseDensity, type RoleGrant } from "@/lib/staff/profile";
import { changePassword, saveProfile } from "@/lib/staff/profile-actions";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type MembershipRow = {
  id: string;
  status: string;
  tenant_id: string;
  membership_roles: { property_id: string | null; roles: { id: string; name: string } | null }[];
};

export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;

  // Every read here is of the person's own rows: row level security limits profiles, memberships and their roles to them.
  const [profileQ, memberQ, propQ] = await Promise.all([
    supabase.from("user_profiles").select("full_name, phone, density").maybeSingle(),
    supabase
      .from("tenant_memberships")
      .select("id, status, tenant_id, membership_roles(property_id, roles(id, name))")
      .eq("status", "active"),
    supabase.from("properties").select("id, name"),
  ]);
  const profile = (profileQ.data ?? null) as { full_name: string | null; phone: string | null; density: string } | null;
  const memberships = (memberQ.data ?? []) as unknown as MembershipRow[];
  const propName = new Map(((propQ.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));

  const grants: RoleGrant[] = [];
  const roleIds = new Set<string>();
  for (const m of memberships)
    for (const mr of m.membership_roles) {
      if (!mr.roles) continue;
      grants.push({ role_name: mr.roles.name, property_id: mr.property_id });
      roleIds.add(mr.roles.id);
    }
  const roleLines = describeRoles(grants, (id) => propName.get(id));

  const permQ = roleIds.size
    ? await supabase
        .from("role_permissions")
        .select("permissions(key)")
        .in("role_id", [...roleIds])
    : { data: [], error: null };
  const keys = ((permQ.data ?? []) as unknown as { permissions: { key: string } | null }[])
    .map((r) => r.permissions?.key)
    .filter((k): k is string => typeof k === "string");
  const groups = groupPermissions(keys);
  const density = parseDensity(profile?.density);

  return (
    <main className="max-w-3xl">
      <PageTitle>My profile</PageTitle>
      <PageIntro>Your name, how the staff screens are laid out for you, and your password. Only you can see and change these.</PageIntro>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>

      <section aria-labelledby="details">
        <SectionTitle id="details">Your details</SectionTitle>
        <form action={saveProfile} className="mt-3 grid max-w-xl gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              value={user?.email ?? ""}
              readOnly
              aria-describedby="email-note"
              className={`${inputClass} bg-ink/5 text-muted`}
            />
            <p id="email-note" className="mt-1 text-xs text-muted">
              This is how you sign in. To change it, ask the owner of your hotel.
            </p>
          </div>
          <div>
            <label htmlFor="full_name" className="block text-sm font-medium">
              Full name
            </label>
            <input
              id="full_name"
              name="full_name"
              required
              maxLength={200}
              defaultValue={profile?.full_name ?? ""}
              autoComplete="name"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="phone" className="block text-sm font-medium">
              Phone
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              maxLength={40}
              defaultValue={profile?.phone ?? ""}
              autoComplete="tel"
              className={inputClass}
            />
          </div>
          <fieldset className="md:col-span-2">
            <legend className="text-sm font-medium">Screen spacing</legend>
            <div className="mt-2 space-y-2">
              {DENSITIES.map((d) => (
                <label key={d.value} className="flex items-start gap-3 text-sm">
                  <input type="radio" name="density" value={d.value} defaultChecked={density === d.value} className="mt-0.5" />
                  <span>
                    <span className="font-medium">{d.label}</span>
                    <span className="block text-muted">{d.note}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">This affects only how the pages look to you. It changes nothing you can see or do.</p>
          </fieldset>
          <div className="md:col-span-2">
            <PendingButton className={buttonPrimary} pendingLabel="Saving…">
              Save
            </PendingButton>
          </div>
        </form>
      </section>

      <section aria-labelledby="access" className="mt-10">
        <SectionTitle id="access">Your access</SectionTitle>
        {roleLines.length === 0 ? (
          <p className="mt-2 text-sm text-muted">You have no active role at any hotel.</p>
        ) : (
          <>
            <ul className="mt-3 border-t border-line text-sm">
              {roleLines.map((line) => (
                <li key={line} className="border-b border-line py-2">
                  {line}
                </li>
              ))}
            </ul>
            {groups.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted">What these roles let you do</summary>
                <dl className="mt-2 grid gap-x-6 gap-y-1 md:grid-cols-[12rem_minmax(0,1fr)]">
                  {groups.map((g) => (
                    <div key={g.area} className="contents">
                      <dt className="font-medium">{g.area}</dt>
                      <dd className="text-muted">{g.actions.length > 0 ? g.actions.join(", ") : "Yes"}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
            <p className="mt-3 text-xs text-muted">Roles are set by the owner under Staff &amp; Permissions. You cannot change your own.</p>
          </>
        )}
      </section>

      <section aria-labelledby="password" className="mt-10">
        <SectionTitle id="password">Change your password</SectionTitle>
        <form action={changePassword} className="mt-3 grid max-w-xl gap-4">
          <div>
            <label htmlFor="current" className="block text-sm font-medium">
              Current password
            </label>
            <input
              id="current"
              name="current"
              type="password"
              required
              autoComplete="current-password"
              maxLength={200}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="password-new" className="block text-sm font-medium">
              New password
            </label>
            <input
              id="password-new"
              name="password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              aria-describedby="password-note"
              className={inputClass}
            />
            <p id="password-note" className="mt-1 text-xs text-muted">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>
          <div>
            <label htmlFor="confirm" className="block text-sm font-medium">
              New password again
            </label>
            <input id="confirm" name="confirm" type="password" required autoComplete="new-password" className={inputClass} />
          </div>
          <div>
            <PendingButton className={buttonPrimary} pendingLabel="Changing…">
              Change password
            </PendingButton>
            <p className="mt-2 max-w-prose text-xs text-muted">
              Anywhere else you are signed in will be signed out. This browser stays signed in.
            </p>
          </div>
        </form>
      </section>
    </main>
  );
}
