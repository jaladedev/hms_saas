"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

/**
 * A thin bar across the top of the page while the next page loads.
 *
 * It starts when someone presses a link to another page of this site and ends by itself when the address changes: it
 * remembers the address it started on and shows only while that is still the current one (so, like the menu, there is no
 * effect to reset it). A 15 second cap clears it if the navigation never lands. Links that open elsewhere, new tabs and
 * downloads are ignored.
 */
function Bar() {
  const here = `${usePathname() ?? ""}?${useSearchParams()?.toString() ?? ""}`;
  const [from, setFrom] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(here);

  useEffect(() => {
    current.current = here;
  }, [here]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (`${url.pathname}?${url.searchParams.toString()}` === current.current) return;
      setFrom(current.current);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFrom(null), 15000);
    }
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (from === null || from !== here) return null;
  return (
    <div role="progressbar" aria-label="Loading page" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-1 print:hidden">
      <div className="route-progress-run h-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
    </div>
  );
}

export function RouteProgress() {
  return (
    <Suspense fallback={null}>
      <Bar />
    </Suspense>
  );
}
