"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { NavLink } from "@/components/ui/nav-link";
import { badgeText } from "@/lib/staff/notifications";
import { groupBadgeTotal, groupIdForPath, matchNav, NAV_GROUPS, NAV_HOME, type NavItem } from "@/lib/staff/nav";

const STORE = "hms-nav-open";

/**
 * The staff sidebar's links: Overview, then five sections that open and close, and a "Find a page" box. The section that holds the
 * page being shown is always opened when the page changes; the person's own choices are remembered in this browser (best effort: if
 * storage is blocked, they simply start fresh). A closed section still shows how many things need attention inside it. Typing in the
 * box lists matching pages from every section; Enter goes to the first, Escape clears, and "/" focuses the box from anywhere on the
 * page that is not a field. Rights are not decided here: every link is shown and the pages and the database refuse what is not allowed.
 *
 * `badges` maps a link's address to a count (unread notices, new messages, repairs assigned to this person); `badgeNote` is the word
 * a screen reader hears after the count, for each of them.
 */
export function SidebarNav({ badges, badgeNote }: { badges: Record<string, number>; badgeNote: Record<string, string> }) {
  const here = usePathname() ?? "";
  const router = useRouter();
  const uid = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Remembered choices, read once after the first paint so the server and the browser start from the same markup.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>;
      if (saved && typeof saved === "object") setOpen((cur) => ({ ...saved, ...cur }));
    } catch {
      // no storage: start fresh
    }
  }, []);

  // Going to a page opens the section it lives in.
  useEffect(() => {
    const id = groupIdForPath(here);
    if (id) setOpen((cur) => (cur[id] ? cur : { ...cur, [id]: true }));
  }, [here]);

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(open));
    } catch {
      // ignore
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const hits = matchNav(query);
  const searching = query.trim() !== "";

  const linkBase =
    "flex min-h-11 items-center justify-between gap-2 rounded-md px-3 py-2 text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white md:min-h-0 md:py-1.5";
  const linkActive = "bg-white/15 font-medium text-white shadow-[inset_3px_0_0_0_#fff]";

  function renderLink(item: NavItem, hint?: string | null) {
    const n = badges[item.href] ?? 0;
    return (
      <NavLink key={item.href} href={item.href} exact={item.exact} className={linkBase} activeClassName={linkActive}>
        <span className="min-w-0">
          {item.label}
          {hint ? <span className="ml-2 text-xs text-white/50">{hint}</span> : null}
        </span>
        {n > 0 && (
          <>
            <span aria-hidden="true" className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-medium tabular-nums text-navy-900">
              {badgeText(n)}
            </span>
            <span className="sr-only">
              , {n} {badgeNote[item.href] ?? ""}
            </span>
          </>
        )}
      </NavLink>
    );
  }

  return (
    <nav aria-label="Main" className="mt-4 text-sm md:mt-5">
      <div className="px-1">
        <label htmlFor={`${uid}-find`} className="sr-only">
          Find a page
        </label>
        <input
          id={`${uid}-find`}
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              setQuery("");
              router.push(hits[0].href);
            }
          }}
          placeholder="Find a page…  ( / )"
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 w-full rounded-md border border-white/25 bg-white/10 px-3 py-2 text-white placeholder:text-white/55 focus-visible:outline-2 focus-visible:outline-white md:min-h-0 md:py-1.5"
        />
      </div>

      {searching ? (
        <div className="mt-3" role="region" aria-label="Matching pages" aria-live="polite">
          {hits.length === 0 ? (
            <p className="px-3 py-2 text-white/70">No page matches “{query.trim()}”.</p>
          ) : (
            <>
              <p className="sr-only">{hits.length} matching pages</p>
              {hits.map((h) => renderLink(h, h.group))}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="mt-3">{renderLink(NAV_HOME)}</div>
          {NAV_GROUPS.map((g) => {
            const isOpen = open[g.id] === true;
            const total = groupBadgeTotal(g, badges);
            const panel = `${uid}-${g.id}`;
            return (
              <div key={g.id} className="mt-2 border-t border-white/10 pt-1">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panel}
                  onClick={() => setOpen((cur) => ({ ...cur, [g.id]: !isOpen }))}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-white/60 hover:text-white focus-visible:outline-2 focus-visible:outline-white md:min-h-0 md:py-1.5"
                >
                  <span>
                    {g.label}
                    {!isOpen && total > 0 && (
                      <>
                        <span
                          aria-hidden="true"
                          className="ml-2 rounded-full bg-white px-2 py-0.5 align-middle text-[11px] font-medium normal-case tabular-nums text-navy-900"
                        >
                          {badgeText(total)}
                        </span>
                        <span className="sr-only">, {total} need attention</span>
                      </>
                    )}
                  </span>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className={`h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none ${isOpen ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <div id={panel} hidden={!isOpen} className="space-y-0.5 pb-1">
                  {g.items.map((item) => renderLink(item))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </nav>
  );
}
