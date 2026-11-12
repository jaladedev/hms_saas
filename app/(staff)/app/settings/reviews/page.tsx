import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { pendingCount, sortReviews, type ReviewRow } from "@/lib/staff/guest-reviews";
import { moderateGuestReview } from "@/lib/staff/hotel-profile-actions";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

const STATUS_TEXT: Record<string, string> = {
  pending: "Waiting for your decision",
  approved: "Shown on your website",
  rejected: "Not shown",
};

/**
 * Guest reviews for the hotel to approve or reject before they show on the website. Guests write them after checking out, from
 * their booking link. A review is never edited, only approved or rejected, and only people who may change the hotel setup
 * (property.configure) can read or decide; the database makes the final decision.
 */
export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, reviewQ] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase
      .from("guest_reviews")
      .select("id, property_id, rating, comment, author, status, created_at")
      .order("created_at", { ascending: false })
      .limit(300),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const reviews = (reviewQ.data ?? []) as ReviewRow[];
  const many = properties.length > 1;

  return (
    <main className="max-w-3xl">
      <PageTitle>Guest reviews</PageTitle>
      <PageIntro>
        Reviews guests wrote after their stay. Nothing shows on your website until you approve it, and you can change your mind later.
        Guests are shown by first name and the first letter of their last name only. Reviews cannot be edited.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {(propQ.error || reviewQ.error) && <ErrorBanner className="mb-6">The reviews could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const mine = sortReviews(reviews.filter((r) => r.property_id === p.id));
        const waiting = pendingCount(mine);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {waiting > 0 && (
              <p className="mt-2 text-sm font-medium">
                {waiting} review{waiting === 1 ? "" : "s"} waiting for a decision
              </p>
            )}
            {mine.length === 0 ? (
              <EmptyState className="mt-4">No reviews yet. Guests can write one from their booking link after they check out.</EmptyState>
            ) : (
              <ul className="mt-4 space-y-4">
                {mine.map((r) => (
                  <li key={r.id} className="rounded border border-line bg-white p-4">
                    <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
                      <span className="font-medium" aria-label={`${r.rating} out of 5`}>
                        <span aria-hidden="true">
                          {"★".repeat(r.rating)}
                          {"☆".repeat(5 - r.rating)}
                        </span>{" "}
                        {r.rating}/5
                      </span>
                      <span>{r.author}</span>
                      <span className="text-muted">{r.created_at.slice(0, 10)}</span>
                      <span className={r.status === "pending" ? "font-medium text-pending" : "text-muted"}>
                        {STATUS_TEXT[r.status] ?? r.status}
                      </span>
                    </p>
                    {r.comment ? (
                      <p className="mt-2 whitespace-pre-line text-sm">{r.comment}</p>
                    ) : (
                      <p className="mt-2 text-sm text-muted">No comment.</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {r.status !== "approved" && (
                        <form action={moderateGuestReview}>
                          <input type="hidden" name="reviewId" value={r.id} />
                          <input type="hidden" name="decision" value="approved" />
                          <PendingButton className={buttonPrimary} pendingLabel="Approving…">
                            Approve
                          </PendingButton>
                        </form>
                      )}
                      {r.status !== "rejected" && (
                        <form action={moderateGuestReview}>
                          <input type="hidden" name="reviewId" value={r.id} />
                          <input type="hidden" name="decision" value="rejected" />
                          <PendingButton className={buttonQuiet} pendingLabel="Rejecting…">
                            Reject
                          </PendingButton>
                        </form>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </main>
  );
}
