import Link from "next/link";
import { buildChecklist, countsFor, progressOf } from "@/lib/staff/setup-checklist";
import { createClient } from "@/lib/supabase/server";
import { PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";

export const dynamic = "force-dynamic";

const SECTIONS = [
  {
    href: "/app/settings/hotel",
    title: "Hotel details",
    text: "The phone, email and short introduction guests see on your website before they search.",
  },
  {
    href: "/app/settings/offers",
    title: "Offers",
    text: "Short promotions shown on your website's homepage, such as a weekend package. A message only; it does not change prices.",
  },
  {
    href: "/app/settings/promo-codes",
    title: "Promo codes",
    text: "Codes guests type on the booking form for a percentage or fixed amount off. Needs discounts to be switched on for your hotel group.",
  },
  {
    href: "/app/settings/pricing",
    title: "Pricing suggestions",
    text: "Rules by occupancy, days before arrival, weekday and event dates, with a floor and ceiling. Shows suggested prices only; it never changes a real price.",
  },
  {
    href: "/app/settings/loyalty",
    title: "Loyalty points",
    text: "Guests earn points on the room price of a stay and staff spend them as a discount on a later booking. Off until you switch it on; needs loyalty points in your hotel group's plan.",
  },
  {
    href: "/app/settings/vouchers",
    title: "Vouchers",
    text: "Gift vouchers with a stored value and one-use discount vouchers, each with a code staff enter on a booking. Come with loyalty points in your hotel group's plan.",
  },
  {
    href: "/app/settings/pos",
    title: "Restaurant menu and places",
    text: "Tables, the bar and room service, and the menu with prices. Orders are taken under Restaurant & bar. Needs restaurant and bar in your hotel group's plan.",
  },
  {
    href: "/app/settings/inventory",
    title: "Stock items, suppliers and recipes",
    text: "What the hotel keeps in stock, who it buys from, and how much of each item a menu portion uses. Purchases and counts are under Stock. Needs stock and purchasing in your hotel group's plan.",
  },
  {
    href: "/app/settings/services",
    title: "Spa, gym and laundry services",
    text: "The services sold to guests with a price, an optional length in minutes and how many can be booked at once. Bookings are made under Spa, gym & laundry. Needs guest services in your hotel group's plan.",
  },
  {
    href: "/app/settings/api",
    title: "API keys and webhooks",
    text: "Let your own website or another system read availability and bookings, and be told when a booking changes. Keys are shown once and can be revoked at once. Needs API access in your hotel group's plan.",
  },
  {
    href: "/app/settings/messages",
    title: "Text messages",
    text: "Texts to guests for a confirmed booking, before arrival and after check-out, with a monthly limit. Off until you switch it on; needs texts in your hotel group's plan.",
  },
  {
    href: "/app/settings/reviews",
    title: "Guest reviews",
    text: "Reviews guests wrote after their stay. Approve the ones you want on your website.",
  },
  {
    href: "/app/settings/rooms",
    title: "Room types and rooms",
    text: "The kinds of room you sell, their capacity and standard price, and the rooms themselves.",
  },
  { href: "/app/settings/rates", title: "Rates", text: "Standard rate plan and different nightly prices for holidays and busy weeks." },
  {
    href: "/app/settings/tax",
    title: "Tax rules",
    text: "Which taxes are added to nights, and which of them also apply to extras such as the minibar and laundry.",
  },
  {
    href: "/app/settings/policies",
    title: "Cancellation and payment policies",
    text: "What guests pay online to keep a booking, whether the balance must be paid before check-in, and what a cancellation costs.",
  },
  {
    href: "/app/settings/discounts",
    title: "Discount limits",
    text: "How large a discount each role may give on a booking. The owner sets these.",
  },
  {
    href: "/app/settings/billing",
    title: "Billing",
    text: "Your plan and the invoices from the platform. For the owner and general manager.",
  },
  {
    href: "/app/settings/events",
    title: "Events and venues",
    text: "Halls and meeting rooms for hire, with a price by the hour or day, and the tax, service charge, deposit and hold time quoted on a hire. Up to 12 venues.",
  },
  {
    href: "/app/settings/experiences",
    title: "Experiences",
    text: "Tours, dinners and transfers a guest can ask for from their booking, with a price. Staff confirm each request and post it to the folio. Up to 12.",
  },
  {
    href: "/app/settings/places",
    title: "Near the hotel",
    text: "Places guests might visit, such as a hall, gardens or a landmark, shown on your website's homepage. Up to 8.",
  },
  {
    href: "/app/settings/platform-access",
    title: "Platform access",
    text: "When someone from the platform opened your setup, who approved the time and how long it lasted. For the owner and general manager.",
  },
  { href: "/app/staff", title: "Staff and permissions", text: "Who can sign in and what each person may do." },
  {
    href: "/app/settings/history",
    title: "Setup history",
    text: "Who changed the room types, rooms, rates, tax rules and staff access, and what they changed. For the owner and general manager.",
  },
];

export default async function SettingsPage() {
  const supabase = await createClient();
  // Each read is on its own and may come back empty (row-level security decides what this person sees). A failed read
  // hides the checklist rather than telling someone their hotel has nothing set up.
  const [propQ, typeQ, roomQ, planQ, taxQ, polQ] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase.from("room_types").select("property_id, status").limit(1000),
    supabase.from("rooms").select("property_id, operational_status").limit(5000),
    supabase.from("rate_plans").select("property_id, is_default, status").limit(1000),
    supabase.from("tax_rules").select("property_id").limit(1000),
    supabase.from("property_policies").select("property_id").limit(1000),
  ]);
  const loaded = ![propQ, typeQ, roomQ, planQ, taxQ, polQ].some((q) => q.error);
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const setup = loaded
    ? properties
        .map((p) => {
          const steps = buildChecklist(
            countsFor(p.id, {
              roomTypes: (typeQ.data ?? []) as { property_id: string; status: string }[],
              rooms: (roomQ.data ?? []) as { property_id: string; operational_status: string }[],
              ratePlans: (planQ.data ?? []) as { property_id: string; is_default: boolean; status: string }[],
              taxRules: (taxQ.data ?? []) as { property_id: string }[],
              policies: (polQ.data ?? []) as { property_id: string }[],
            }),
          );
          return { property: p, steps, progress: progressOf(steps) };
        })
        .filter((x) => !x.progress.complete)
    : [];

  return (
    <main className="max-w-3xl">
      <PageTitle>Settings</PageTitle>
      <PageIntro>Set up the hotel. A new hotel needs room types, rooms and a standard rate plan before it can take a booking.</PageIntro>
      {setup.map(({ property, steps, progress }) => (
        <section
          key={property.id}
          aria-label={`Setup for ${property.name}`}
          className="mt-6 border-l-4 border-primary/40 bg-white px-4 py-4"
        >
          <SectionTitle>{properties.length > 1 ? `Set up ${property.name}` : "Set up your hotel"}</SectionTitle>
          <p className="mt-1 text-sm text-muted">
            {progress.done} of {progress.total} steps done.{" "}
            {progress.ready ? "Guests can book now; the steps left are recommended." : "Finish the first three before guests can book."}{" "}
            <Link href={`/app/setup?property=${property.id}`} className="font-medium text-primary-strong">
              Open the step-by-step guide
            </Link>
          </p>
          <ol className="mt-3 space-y-2 text-sm">
            {steps.map((st) => (
              <li key={st.key} className="flex flex-wrap items-baseline gap-x-3">
                <span aria-hidden="true" className={st.done ? "text-primary-strong" : "text-muted"}>
                  {st.done ? "Done" : st.required ? "To do" : "Suggested"}
                </span>
                {st.done ? (
                  <span className="text-muted">
                    <span className="sr-only">Done: </span>
                    {st.title}
                  </span>
                ) : (
                  <Link href={st.href} className="font-medium text-primary-strong focus-visible:outline-2 focus-visible:outline-primary">
                    {st.title}
                  </Link>
                )}
                {!st.done && <span className="text-muted">{st.text}</span>}
              </li>
            ))}
          </ol>
        </section>
      ))}

      <ul className="mt-6 divide-y divide-line border-y border-line">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="block py-4 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary">
              <span className="font-medium text-primary-strong">{s.title}</span>
              <span className="mt-1 block max-w-prose text-sm text-muted">{s.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
