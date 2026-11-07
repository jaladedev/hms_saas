"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

/**
 * Wraps the staff sidebar's contents so it works on a phone.
 *
 * From the `md` breakpoint (768px) up nothing changes: the brand and the whole menu are shown, as a sidebar. Below it the
 * sidebar is a bar across the top with a Menu button, and the links stay out of the way until that is pressed. A fixed
 * 240px sidebar left about 150px for the page on a 390px phone, and the spec asks for staff screens that work on a phone.
 *
 * The menu closes by itself when the person goes to another page: it remembers the page it was opened on, and is open
 * only while that is still the current page (so there is no effect to reset it).
 */
export function NavMenu({ brand, children }: { brand: ReactNode; children: ReactNode }) {
  const here = usePathname() ?? "";
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn !== null && openOn === here;
  return (
    <>
      <div className="flex items-center justify-between">
        {brand}
        <button
          type="button"
          aria-expanded={open}
          aria-controls="staff-menu"
          onClick={() => setOpenOn(open ? null : here)}
          className="rounded border border-white/40 px-3 py-1.5 text-white focus-visible:outline-2 focus-visible:outline-white md:hidden print:hidden"
        >
          Menu
        </button>
      </div>
      <div id="staff-menu" className={open ? "block" : "hidden md:block"}>
        {children}
      </div>
    </>
  );
}
