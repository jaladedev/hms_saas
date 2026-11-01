import Link from "next/link";

export const dynamic = "force-dynamic";

const SECTIONS = [
  { href: "/app/settings/rooms", title: "Room types and rooms", text: "The kinds of room you sell, their capacity and standard price, and the rooms themselves." },
  { href: "/app/settings/rates", title: "Rates", text: "Standard rate plan and different nightly prices for holidays and busy weeks." },
  { href: "/app/settings/tax", title: "Tax rules", text: "Which taxes are added to nights, and which of them also apply to extras such as the minibar and laundry." },
  { href: "/app/staff", title: "Staff and permissions", text: "Who can sign in and what each person may do." },
];

export default function SettingsPage() {
  return (
    <main className="max-w-3xl">
      <h1 className="font-display text-3xl">Settings</h1>
      <p className="mt-2 max-w-prose text-muted">Set up the hotel. A new hotel needs room types, rooms and a standard rate plan before it can take a booking.</p>
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
