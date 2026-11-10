import Link from "next/link";
import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, linkClass, PageIntro, PageTitle } from "@/components/staff/ui";
import { buildChecklist, countsFor, progressOf, wizardHref, wizardView } from "@/lib/staff/setup-checklist";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** The guided setup: one step at a time over the settings screens that already exist. What is done is worked out from what is saved. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, typeQ, roomQ, planQ, taxQ, polQ] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase.from("room_types").select("property_id, status").limit(1000),
    supabase.from("rooms").select("property_id, operational_status").limit(5000),
    supabase.from("rate_plans").select("property_id, is_default, status").limit(1000),
    supabase.from("tax_rules").select("property_id").limit(1000),
    supabase.from("property_policies").select("property_id").limit(1000),
  ]);
  if ([propQ, typeQ, roomQ, planQ, taxQ, polQ].some((q) => q.error)) {
    return (
      <main className="max-w-3xl">
        <PageTitle>Set up your hotel</PageTitle>
        <ErrorBanner className="mt-6">The setup could not be loaded. Reload the page to try again.</ErrorBanner>
      </main>
    );
  }
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const stepsOf = (id: string) =>
    buildChecklist(
      countsFor(id, {
        roomTypes: (typeQ.data ?? []) as { property_id: string; status: string }[],
        rooms: (roomQ.data ?? []) as { property_id: string; operational_status: string }[],
        ratePlans: (planQ.data ?? []) as { property_id: string; is_default: boolean; status: string }[],
        taxRules: (taxQ.data ?? []) as { property_id: string }[],
        policies: (polQ.data ?? []) as { property_id: string }[],
      }),
    );
  const first = properties[0];
  if (!first) {
    return (
      <main className="max-w-3xl">
        <PageTitle>Set up your hotel</PageTitle>
        <EmptyState className="mt-6">You do not have a hotel to set up yet.</EmptyState>
      </main>
    );
  }
  const asked = typeof search.property === "string" ? properties.find((p) => p.id === search.property) : undefined;
  const property = asked ?? properties.find((p) => !progressOf(stepsOf(p.id)).complete) ?? first;
  const view = wizardView(stepsOf(property.id), search.step);
  const { current, progress } = view;

  return (
    <main className="max-w-3xl">
      <PageTitle>{properties.length > 1 ? `Set up ${property.name}` : "Set up your hotel"}</PageTitle>
      <PageIntro>
        Five short steps. Each one opens the screen where you make the change; come back here when you are done and the step shows as done.
        {properties.length > 1 && " Use the Working in switcher at the top to make the change for this hotel."}
      </PageIntro>

      {properties.length > 1 && (
        <p className="mt-4 text-sm" role="navigation" aria-label="Which hotel">
          {properties.map((p) => (
            <Link
              key={p.id}
              href={wizardHref(p.id, "")}
              className={`mr-3 ${p.id === property.id ? "font-medium" : linkClass}`}
              aria-current={p.id === property.id ? "page" : undefined}
            >
              {p.name}
            </Link>
          ))}
        </p>
      )}

      <p className="mt-6 text-sm text-muted" aria-live="polite">
        {progress.done} of {progress.total} steps done.{" "}
        {progress.complete
          ? "Everything is set up."
          : progress.ready
            ? "Guests can book now; the steps left are recommended."
            : "Finish the first three before guests can book."}
      </p>

      <ol className="mt-3 flex flex-wrap gap-2" aria-label="Steps">
        {view.steps.map((s, i) => (
          <li key={s.key}>
            <Link
              href={wizardHref(property.id, s.key)}
              aria-current={s.key === current.key ? "step" : undefined}
              className={`block rounded px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-primary ${
                s.key === current.key ? "bg-navy-900 text-white" : "bg-ink/5 text-ink hover:bg-ink/10"
              }`}
            >
              {i + 1}. {s.title}
              <span className="sr-only">{s.done ? " (done)" : s.required ? " (to do)" : " (suggested)"}</span>
              {s.done && <span aria-hidden="true"> ✓</span>}
            </Link>
          </li>
        ))}
      </ol>

      <section className="mt-8 border-l-4 border-primary/40 bg-white px-4 py-5" aria-labelledby="step-title">
        <p className="text-sm text-muted">
          Step {view.index + 1} of {view.steps.length} · {current.required ? "Needed before guests can book" : "Suggested"}
          {current.done && " · Done"}
        </p>
        <h2 id="step-title" className="mt-1 text-lg font-semibold">
          {current.title}
        </h2>
        <p className="mt-2 max-w-prose">{current.text}</p>
        <p className="mt-4">
          <Link href={current.href} className={current.done ? buttonQuiet : buttonPrimary}>
            {current.done ? "Open it again" : "Open this step"}
          </Link>
        </p>
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        {view.prev && (
          <Link href={wizardHref(property.id, view.prev.key)} className={linkClass}>
            Back: {view.prev.title}
          </Link>
        )}
        {view.next ? (
          <Link href={wizardHref(property.id, view.next.key)} className={linkClass}>
            {current.done || !current.required ? "Next" : "Skip for now"}: {view.next.title}
          </Link>
        ) : (
          <Link href="/app" className={linkClass}>
            {progress.ready ? "Go to the overview" : "Back to the overview"}
          </Link>
        )}
      </div>
    </main>
  );
}
