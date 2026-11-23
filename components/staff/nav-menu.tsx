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
export function NavMenu({
  brand,
  children,
  footer,
  attention = 0,
}: {
  brand: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** How many things need attention across the menu; shown on the Menu button while the menu is closed, so a phone user sees it. */
  attention?: number;
}) {
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

  // While the phone menu is open the page behind it does not scroll. Restored on close, on a page change and on unmount.
  useEffect(() => {
    if (!open) return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
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
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-white/40 px-4 py-2 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:hidden print:hidden"
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
          {!open && attention > 0 && (
            <>
              <span aria-hidden="true" className="rounded-full bg-white px-2 py-0.5 text-xs font-medium tabular-nums text-navy-900">
                {attention > 99 ? "99+" : attention}
              </span>
              <span className="sr-only">, {attention} need attention</span>
            </>
          )}
        </button>
      </div>
      <div
        id="staff-menu"
        className={`${open ? "flex max-md:max-h-[calc(100dvh-5.5rem)]" : "hidden"} flex-col md:flex md:min-h-0 md:flex-1`}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer ? <div className="shrink-0 border-t border-white/15 pb-2 pt-4">{footer}</div> : null}
      </div>
    </div>
  );
}
