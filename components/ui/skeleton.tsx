/** Grey placeholder shapes shown while a page loads. Decorative; the page's own loading wrapper announces the wait. */
export function Bone({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-line/70 motion-reduce:animate-none ${className}`} />;
}

/** A page-shaped placeholder: a title, a few summary tiles and a table of rows. */
export function PageSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="max-w-6xl">
      <span className="sr-only">{label}…</span>
      <Bone className="h-9 w-64" />
      <Bone className="mt-3 h-4 w-96 max-w-full" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Bone key={i} className="h-24" />
        ))}
      </div>
      <div className="mt-6 space-y-2">
        <Bone className="h-10" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Bone key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}
