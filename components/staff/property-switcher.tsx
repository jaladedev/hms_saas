"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { setActiveProperty } from "@/lib/staff/property-actions";

/** Header control for people with more than one property. Pages that show a single property open on this one. */
export function PropertySwitcher({ properties, currentId }: { properties: { id: string; name: string }[]; currentId: string }) {
  const path = usePathname();
  const qs = useSearchParams().toString();
  return (
    <form action={setActiveProperty} className="mt-6 border-t border-white/15 pt-4">
      <input type="hidden" name="returnTo" value={qs ? `${path}?${qs}` : path} />
      <label htmlFor="active-property" className="block text-white/70">
        Working in
      </label>
      <select
        id="active-property"
        name="propertyId"
        defaultValue={currentId}
        className="mt-1 w-full rounded border border-white/30 bg-navy-800 px-2 py-1 text-white focus-visible:outline-2 focus-visible:outline-white"
      >
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="mt-2 text-white underline underline-offset-2 hover:text-white/80 focus-visible:outline-2 focus-visible:outline-white"
      >
        Switch
      </button>
    </form>
  );
}
