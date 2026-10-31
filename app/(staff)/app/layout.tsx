import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/staff/auth-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Items without an href are placeholders until their phase lands.
const NAV: { label: string; href?: string }[] = [
  { label: "Overview", href: "/app" },
  { label: "Front Desk" },
  { label: "Reservations", href: "/app/reservations" },
  { label: "Room Management" },
  { label: "Guests" },
  { label: "Housekeeping" },
  { label: "Payments & Billing" },
  { label: "Refunds", href: "/app/refunds" },
  { label: "Guest emails", href: "/app/emails" },
  { label: "Reports" },
  { label: "Staff & Permissions" },
  { label: "Settings" },
];

// Every /app route requires a signed-in user. Permission checks happen again in the
// database (RLS and has_permission); this redirect is only the first layer.
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 bg-navy-900 p-4 text-sm text-white">
        <div className="font-display text-xl">HMS</div>
        <nav className="mt-6 space-y-2 text-white/80">
          {NAV.map((item) =>
            item.href ? (
              <Link key={item.label} href={item.href} className="block text-white focus-visible:outline-2 focus-visible:outline-white">{item.label}</Link>
            ) : (
              <div key={item.label}>{item.label}</div>
            ),
          )}
        </nav>
        <div className="mt-10 border-t border-white/15 pt-4">
          <p className="truncate text-white/70" title={data.user.email ?? undefined}>{data.user.email}</p>
          <form action={signOut} className="mt-2">
            <button type="submit" className="text-white underline underline-offset-2 hover:text-white/80 focus-visible:outline-2 focus-visible:outline-white">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="flex-1 p-6">{children}</div>
    </div>
  );
}
