import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/staff/breadcrumbs";
import { NavMenu } from "@/components/staff/nav-menu";
import { SidebarNav } from "@/components/staff/sidebar-nav";
import { RouteProgress } from "@/components/ui/route-progress";
import { signOut } from "@/lib/staff/auth-actions";
import { OfflineSupport } from "@/components/offline/offline-support";
import { SignOutForm } from "@/components/staff/sign-out-form";
import { PropertySwitcher } from "@/components/staff/property-switcher";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";
import { parseDensity } from "@/lib/staff/profile";
import { lookStyle, THEME_WRAPPER_CLASS } from "@/lib/theme";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { manifest: "/manifest.webmanifest" };

export const dynamic = "force-dynamic";

// Every /app route requires a signed-in user. Permission checks happen again in the
// database (RLS and has_permission); this redirect is only the first layer.
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  // How many live repairs are assigned to this person. Row level security limits the read to people who may see
  // maintenance, and a failed read shows no badge rather than a wrong number.
  const mineQ = await supabase
    .from("maintenance_requests")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "in_progress"])
    .eq("assigned_to", data.user.id);
  const myRepairs = mineQ.error ? 0 : (mineQ.count ?? 0);

  // Guest messages nobody has answered yet, at the hotels this person may read them for (row level security decides). A failed
  // read shows no badge rather than a wrong number.
  const msgQ = await supabase.from("contact_messages").select("id", { count: "exact", head: true }).eq("status", "new");
  const newMessages = msgQ.error ? 0 : (msgQ.count ?? 0);

  // Unread notices for this person. A failed read shows no badge rather than a wrong number.
  const unreadQ = await supabase.rpc("notification_unread_count");
  const unread = unreadQ.error || typeof unreadQ.data !== "number" ? 0 : unreadQ.data;

  // The person's own spacing preference. A failed read, or a person with no profile row yet, gets the standard spacing.
  const profileQ = await supabase.from("user_profiles").select("density").maybeSingle();
  const density = parseDensity((profileQ.data as { density?: string } | null)?.density);

  // The header switcher appears only for people who can see more than one open property. The hotel being worked in also
  // decides the look (its chosen theme, or the standard look when it has not chosen one or the read fails).
  const propsQ = await supabase
    .from("properties")
    .select("id, name, theme, theme_primary, theme_font_display, theme_font_body, theme_radius")
    .eq("status", "active")
    .order("name");
  const switchable = (propsQ.data ?? []) as {
    id: string;
    name: string;
    theme: string | null;
    theme_primary: string | null;
    theme_font_display: string | null;
    theme_font_body: string | null;
    theme_radius: string | null;
  }[];
  const current = pickProperty(switchable, undefined, await rememberedProperty());

  // The counts shown beside links (a closed section adds its own up), and the words a screen reader hears after each.
  const badges: Record<string, number> = {
    "/app/notifications": unread,
    "/app/messages": newMessages,
    "/app/maintenance": myRepairs,
  };
  const badgeNote: Record<string, string> = {
    "/app/notifications": "unread",
    "/app/messages": "new",
    "/app/maintenance": "assigned to you",
  };

  return (
    <div
      className={`flex min-h-screen flex-col md:flex-row print:block print:min-h-0 print:bg-white ${THEME_WRAPPER_CLASS}`}
      style={lookStyle({
        theme: current?.theme,
        primary: current?.theme_primary,
        fontDisplay: current?.theme_font_display,
        fontBody: current?.theme_font_body,
        radius: current?.theme_radius,
      })}
    >
      <RouteProgress />
      <aside className="z-30 shrink-0 bg-navy-900 p-4 text-sm text-white max-md:sticky max-md:top-0 md:sticky md:top-0 md:h-screen md:w-60 print:hidden">
        <NavMenu
          attention={unread + newMessages + myRepairs}
          footer={
            <>
              <Link
                href="/app/profile"
                className="block truncate text-white/70 underline-offset-2 hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-white"
                title={data.user.email ?? undefined}
              >
                {data.user.email}
                <span className="sr-only">, your profile</span>
              </Link>
              <SignOutForm action={signOut} />
            </>
          }
          brand={<div className="font-display text-xl">HMS</div>}
        >
          <SidebarNav badges={badges} badgeNote={badgeNote} />
          {switchable.length > 1 && current && <PropertySwitcher properties={switchable} currentId={current.id} />}
        </NavMenu>
      </aside>
      <div data-density={density} className="min-w-0 flex-1 p-4 md:p-6 print:p-0">
        <OfflineSupport />
        <Breadcrumbs />
        {children}
      </div>
    </div>
  );
}
