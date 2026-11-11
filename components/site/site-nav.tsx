"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NavLink } from "@/components/ui/nav-link";

const LINKS = [
  { href: "/#rooms", label: "Rooms" },
  { href: "/policies", label: "Policies" },
  { href: "/contact", label: "Contact" },
];

/**
 * The guest site's header links. From the `md` breakpoint up they sit in the header; on a phone they were missing
 * altogether, so a Menu button opens them in a panel under the header. The panel closes on Escape and by itself when
 * the guest goes to another page (it remembers the page it was opened on, as the staff menu does). The header it hangs
 * from must be `relative`.
 */
export function SiteNav() {
  const here = usePathname() ?? "";
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn !== null && openOn === here;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenOn(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const link = "hover:text-primary focus-visible:outline-2 focus-visible:outline-primary";
  return (
    <>
      <nav aria-label="Hotel" className="hidden items-center gap-8 text-sm tracking-wide md:flex">
        {LINKS.map((l) => (
          <NavLink
            key={l.href}
            href={l.href}
            className={`${link} border-b-2 border-transparent py-1`}
            activeClassName="!border-primary text-primary"
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="site-menu"
        onClick={() => setOpenOn(open ? null : here)}
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-line px-4 py-2 text-sm hover:bg-paper focus-visible:outline-2 focus-visible:outline-primary md:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
        Menu
      </button>
      <nav
        id="site-menu"
        aria-label="Hotel menu"
        hidden={!open}
        className="absolute inset-x-0 top-full z-30 border-b border-line bg-white px-4 pb-3 shadow-sm md:hidden"
      >
        {LINKS.map((l) => (
          <NavLink
            key={l.href}
            href={l.href}
            className={`${link} block border-b border-line/60 py-3 last:border-b-0`}
            activeClassName="font-medium text-primary"
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
