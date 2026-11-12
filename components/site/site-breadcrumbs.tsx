import Link from "next/link";

/** The trail across the top of a guest page: earlier steps link back, the last is the page you are on. */
export function SiteBreadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        {items.map((it, i) => (
          <li key={it.label} className="flex items-center gap-2">
            {i > 0 ? (
              <span aria-hidden="true" className="text-line">
                /
              </span>
            ) : null}
            {it.href ? (
              <Link
                href={it.href}
                className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
              >
                {it.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium text-ink">
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
