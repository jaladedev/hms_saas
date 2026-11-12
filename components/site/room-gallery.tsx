"use client";

import { useState } from "react";
import { PhotoFrame } from "@/components/ui/photo-frame";

/**
 * The room's pictures: one large, the rest as small buttons that swap it in. Each picture shows a soft block until it has
 * loaded. With no pictures it shows the room's name on a plain block; with one, no buttons.
 */
export function RoomGallery({ name, photos }: { name: string; photos: { url: string; caption: string | null }[] }) {
  const [i, setI] = useState(0);
  const current = photos[i];
  if (!current) {
    return (
      <div
        aria-hidden="true"
        className="flex aspect-[4/3] w-full items-center justify-center rounded-2xl border border-line bg-line/40 font-display text-2xl text-muted"
      >
        {name}
      </div>
    );
  }
  return (
    <div>
      <PhotoFrame
        key={current.url}
        src={current.url}
        alt={current.caption ?? `${name} photo ${i + 1} of ${photos.length}`}
        className="aspect-[4/3] w-full rounded-2xl border border-line"
        priority={i === 0}
      />
      {photos.length > 1 ? (
        <ul aria-label={`Photos of ${name}`} className="mt-3 grid grid-cols-4 gap-3">
          {photos.map((p, n) => (
            <li key={p.url}>
              <button
                type="button"
                onClick={() => setI(n)}
                aria-pressed={n === i}
                aria-label={`Show photo ${n + 1} of ${photos.length}`}
                className={`block w-full overflow-hidden rounded-xl border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${n === i ? "border-primary" : "border-transparent"}`}
              >
                <PhotoFrame src={p.url} alt="" className="aspect-[4/3] w-full" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
