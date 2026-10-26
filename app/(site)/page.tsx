export const dynamic = "force-dynamic";

// Guest booking site (UI spec section 3). The tenant is resolved from the request host
// via tenant_domains, never from the URL or a form field. Placeholder until Phase 5.
export default function GuestHome() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="font-display text-4xl">Guest booking site</h1>
      <p className="mt-3 text-muted">Online booking arrives in Phase 5 of the plan.</p>
    </main>
  );
}
