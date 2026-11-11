"use client";

import { useState } from "react";
import { addExtras, AMENITY_GROUPS, amenityValue, splitAmenities } from "@/lib/staff/amenities";
import { MAX_AMENITIES } from "@/lib/staff/room-setup";

/**
 * Choose a room type's amenities from a list, and add the hotel's own. It sends one field, `name` (default "amenities"),
 * which the server reads exactly as it read the old comma-separated box, so the save actions did not change.
 * Pressing Enter in the "add your own" box adds the item; it does not send the form.
 */
export function AmenityPicker({ id, name = "amenities", initial = [] }: { id: string; name?: string; initial?: string[] }) {
  const start = splitAmenities(initial);
  const [picked, setPicked] = useState<string[]>(start.picked);
  const [extras, setExtras] = useState<string[]>(start.extras);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const total = picked.length + extras.length;
  const full = total >= MAX_AMENITIES;

  const order = AMENITY_GROUPS.flatMap((g) => g.items);
  function toggle(item: string, on: boolean) {
    setError(null);
    setPicked((cur) => {
      const next = on ? [...cur, item] : cur.filter((x) => x !== item);
      return order.filter((a) => next.includes(a));
    });
  }
  function add() {
    if (!draft.trim()) return;
    const r = addExtras(picked, extras, draft);
    setError(r.error);
    if (!r.error) {
      setExtras(r.extras);
      setDraft("");
    }
  }

  return (
    <div>
      <input type="hidden" name={name} value={amenityValue(picked, extras)} />
      <p id={`${id}-count`} className="text-sm text-muted" aria-live="polite">
        {total} of {MAX_AMENITIES} chosen. Guests see these when they search.
      </p>

      <div className="mt-2 space-y-2">
        {AMENITY_GROUPS.map((g, i) => (
          <details key={g.title} open={i === 0 || g.items.some((a) => picked.includes(a))} className="rounded border border-line">
            <summary className="cursor-pointer px-3 py-1.5 text-sm font-medium">
              {g.title}{" "}
              <span className="font-normal text-muted">
                ({g.items.filter((a) => picked.includes(a)).length} of {g.items.length})
              </span>
            </summary>
            <ul className="grid gap-x-4 px-3 pb-2 sm:grid-cols-2">
              {g.items.map((item, n) => {
                const on = picked.includes(item);
                const cid = `${id}-${i}-${n}`;
                return (
                  <li key={item} className="flex items-center gap-2 py-1">
                    <input
                      id={cid}
                      type="checkbox"
                      checked={on}
                      disabled={!on && full}
                      onChange={(e) => toggle(item, e.target.checked)}
                      className="h-4 w-4"
                    />
                    <label htmlFor={cid} className="text-sm">
                      {item}
                    </label>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>

      <div className="mt-3">
        <label htmlFor={`${id}-own`} className="block text-sm">
          Add your own
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={`${id}-own`}
            value={draft}
            maxLength={120}
            disabled={full}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Rooftop terrace"
            aria-describedby={error ? `${id}-err` : undefined}
            className="w-full rounded border border-line bg-white px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          />
          <button
            type="button"
            onClick={add}
            disabled={full || !draft.trim()}
            className="shrink-0 rounded border border-line bg-white px-3 py-1.5 text-sm font-medium hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {error ? (
          <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-critical">
            {error}
          </p>
        ) : null}
        {extras.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Your own amenities">
            {extras.map((x) => (
              <li
                key={x}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-3 pr-1 text-sm text-primary-strong"
              >
                {x}
                <button
                  type="button"
                  aria-label={`Remove ${x}`}
                  onClick={() => setExtras((cur) => cur.filter((e) => e !== x))}
                  className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
