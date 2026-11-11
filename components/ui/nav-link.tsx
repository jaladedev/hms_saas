"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Spinner } from "./spinner";

/** Shows a spinner once the link has been pressed and its page is still loading. It must sit inside the `<Link>`. */
function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span className="pending-fade ml-2 inline-flex align-middle">
      <Spinner className="h-3.5 w-3.5" />
      <span className="sr-only">Loading</span>
    </span>
  );
}

/** Whether `href` is the page being shown. A link with a #hash never counts; `exact` stops a parent link lighting up for its children. */
export function isActive(pathname: string, href: string, exact = false): boolean {
  if (href.includes("#")) return false;
  const path = href.split("?")[0] ?? href;
  if (pathname === path) return true;
  return !exact && pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
}

/**
 * A navigation link that marks the current page (`aria-current`) and shows a spinner while the next page loads.
 * `className` is the look of every link, `activeClassName` is added on the current page.
 */
export function NavLink({
  href,
  exact = false,
  className = "",
  activeClassName = "",
  children,
}: {
  href: string;
  exact?: boolean;
  className?: string;
  activeClassName?: string;
  children: ReactNode;
}) {
  const here = usePathname() ?? "";
  const active = isActive(here, href, exact);
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={`${className} ${active ? activeClassName : ""}`}>
      {children}
      <LinkPending />
    </Link>
  );
}
