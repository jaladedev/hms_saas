import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
          {["Overview", "Front Desk", "Reservations", "Room Management", "Guests", "Housekeeping",
            "Payments & Billing", "Reports", "Staff & Permissions", "Settings"].map((item) => (
            <div key={item}>{item}</div>
          ))}
        </nav>
      </aside>
      <div className="flex-1 p-6">{children}</div>
    </div>
  );
}
