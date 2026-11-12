import { notFound, redirect } from "next/navigation";
import { NavMenu } from "@/components/staff/nav-menu";
import { NavLink } from "@/components/ui/nav-link";
import { RouteProgress } from "@/components/ui/route-progress";
import { readAccess, waitingForMe } from "@/lib/platform/access";
import { overdueInvoices, readOpenInvoices } from "@/lib/platform/invoices";
import { signOut } from "@/lib/staff/auth-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Every /platform page needs a signed-in platform admin or support user. Anyone else sees "not found", so the area is not advertised. */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login?next=/platform");
  const level = await supabase.rpc("platform_level");
  if (level.error || !level.data) notFound();
  // Admins see how many access requests wait for them. A failed read shows no count rather than breaking the menu.
  const owed = await supabase.rpc("platform_open_invoices");
  const lateCount = owed.error ? 0 : overdueInvoices(readOpenInvoices(owed.data), new Date().toISOString().slice(0, 10)).length;
  let waiting = 0;
  if (level.data === "admin") {
    const pending = await supabase.rpc("platform_list_access", { p_status: "pending" });
    waiting = pending.error ? 0 : waitingForMe(readAccess(pending.data));
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <RouteProgress />
      <aside className="z-30 shrink-0 bg-navy-900 p-4 text-sm text-white max-md:sticky max-md:top-0 md:sticky md:top-0 md:h-screen md:w-60">
        <NavMenu
          footer={
            <>
              <p className="truncate text-white/70" title={data.user.email ?? undefined}>
                {data.user.email}
              </p>
              <p className="text-white/70">{level.data === "admin" ? "Platform admin" : "Platform support (read only)"}</p>
              <form action={signOut} className="mt-2">
                <button
                  type="submit"
                  className="text-white underline underline-offset-2 hover:text-white/80 focus-visible:outline-2 focus-visible:outline-white"
                >
                  Sign out
                </button>
              </form>
            </>
          }
          brand={<div className="font-display text-xl">HMS platform</div>}
        >
          <nav aria-label="Platform" className="mt-4 md:mt-6">
            <NavLink
              href="/platform"
              exact
              className="block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5"
              activeClassName="bg-white/15 font-medium"
            >
              Hotels
            </NavLink>
            <NavLink
              href="/platform/plans"
              className="block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5"
              activeClassName="bg-white/15 font-medium"
            >
              Plans
            </NavLink>
            <NavLink
              href="/platform/entitlements"
              className="block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5"
              activeClassName="bg-white/15 font-medium"
            >
              Entitlements
            </NavLink>
            <NavLink
              href="/platform/tickets"
              className="block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5"
              activeClassName="bg-white/15 font-medium"
            >
              Support tickets
            </NavLink>
            <NavLink
              href="/platform/invoices"
              className="block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5"
              activeClassName="bg-white/15 font-medium"
            >
              Unpaid invoices
              {lateCount > 0 && (
                <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-navy-900">
                  {lateCount}
                  <span className="sr-only"> overdue</span>
                </span>
              )}
            </NavLink>
            <NavLink
              href="/platform/access"
              className="block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5"
              activeClassName="bg-white/15 font-medium"
            >
              Access requests
              {waiting > 0 && (
                <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-navy-900">
                  {waiting}
                  <span className="sr-only"> waiting for you</span>
                </span>
              )}
            </NavLink>
            {level.data === "admin" && (
              <NavLink
                href="/platform/new"
                className="block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5"
                activeClassName="bg-white/15 font-medium"
              >
                Add a hotel
              </NavLink>
            )}
          </nav>
        </NavMenu>
      </aside>
      <div className="min-w-0 flex-1 p-4 md:p-6">{children}</div>
    </div>
  );
}
