"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Wraps the staff sidebar's contents so it works on a phone.
 *
 * From the `md` breakpoint (768px) up the brand and the whole menu are shown, as a sidebar that stays in view and scrolls
 * on its own when the menu is longer than the screen. The `footer` (profile and sign out) is pinned to the bottom of the
 * sidebar and the open phone menu, outside the part that scrolls. Below it the sidebar is a bar that stays at the top of the page
 * with a Menu button, and the links stay out of the way until that is pressed. The open menu scrolls inside the screen
 * rather than pushing the page down. Escape closes it.
 *
 * The menu closes by itself when the person goes to another page: it remembers the page it was opened on, and is open
 * only while that is still the current page (so there is no effect to reset it).
 */
export function NavMenu({ brand, children, footer }: { brand: ReactNode; children: ReactNode; footer?: ReactNode }) {
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

  return (
    <div className="md:flex md:h-full md:flex-col">
      <div className="flex items-center justify-between">
        {brand}
        <button
          type="button"
          aria-expanded={open}
          aria-controls="staff-menu"
          onClick={() => setOpenOn(open ? null : here)}
          className="inline-flex items-center gap-2 rounded border border-white/40 px-3 py-1.5 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:hidden print:hidden"
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
      </div>
      <div
        id="staff-menu"
        className={`${open ? "flex max-md:max-h-[calc(100dvh-4.5rem)]" : "hidden"} flex-col md:flex md:min-h-0 md:flex-1`}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="shrink-0 border-t border-white/15 pb-2 pt-4">{footer}</div> : null}
      </div>
    </div>
  );
}
