import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NavMenu } from "@/components/staff/nav-menu";
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

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="shrink-0 bg-navy-900 p-4 text-sm text-white md:w-60">
        <NavMenu brand={<div className="font-display text-xl">HMS platform</div>}>
          <nav className="mt-6 space-y-0 md:space-y-2">
            <Link href="/platform" className="block py-3 text-white focus-visible:outline-2 focus-visible:outline-white md:py-0">Hotels</Link>
            {level.data === "admin" && <Link href="/platform/new" className="block py-3 text-white focus-visible:outline-2 focus-visible:outline-white md:py-0">Add a hotel</Link>}
          </nav>
          <div className="mt-10 border-t border-white/15 pt-4">
            <p className="truncate text-white/70" title={data.user.email ?? undefined}>{data.user.email}</p>
            <p className="text-white/70">{level.data === "admin" ? "Platform admin" : "Platform support (read only)"}</p>
            <form action={signOut} className="mt-2">
              <button type="submit" className="text-white underline underline-offset-2 hover:text-white/80 focus-visible:outline-2 focus-visible:outline-white">Sign out</button>
            </form>
          </div>
        </NavMenu>
      </aside>
      <div className="min-w-0 flex-1 p-4 md:p-6">{children}</div>
    </div>
  );
}
