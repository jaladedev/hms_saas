# Handoff

Last updated: 2026-10-26. Read this first, then `TODO.md`.

## What this is

Multi-tenant hotel management SaaS. First customer: a boutique hotel in Ibadan, Nigeria.
Stack: Next.js, TypeScript, Tailwind, Supabase (Postgres, Auth, Storage), Paystack.

## Source documents

| Document | Where | Use for |
| --- | --- | --- |
| DB spec and UI spec | `docs/specs/db-spec.md`, `docs/specs/ui-spec.md` | Original requirements |
| HMS Spec Review and Implementation Plan | Claude doc: https://claude.ai/artifact/3x6hTNbqRqMtwGR5eDPi4s | Conflicts found in the specs, prototype review, phases, decisions |
| HMS System Design | Claude doc: https://claude.ai/artifact/KZr9xyNQc36Sxx5qYuLh1H | The build reference: schema, claims SQL, operations, payments, RLS, reporting, delivery plan |
| Prototype `Hms-Full-Platform.html` | Not in this repo (1.1 MB, compiled React bundle with sample data) | Visual and workflow reference only. Do not extend it; rebuild screens against real data |

Where the System Design differs from the original DB spec, the System Design wins. Main differences:
one shared `room_inventory_claims` table instead of separate allocations, holds and blocks;
`reservation_rooms` and `reservation_nights` for single and multi-room bookings with a per-night price
snapshot; `payment_attempts` separate from `payments`; `platform_admins` separate from tenant
memberships; `tenant_domains` for host-based tenant resolution; `reservations.attention_reason` instead
of an extra status.

## Decisions already made

- Single and multi-room reservations are both in the MVP. Rules adopted: all-or-nothing booking,
  per-room check-in and check-out, one invoice per reservation unless split billing is needed.
- Suggested defaults in the review doc's decision table were adopted as given.
- Money is `bigint` kobo. Dates are the property's local business date. Reservation ranges are
  arrival inclusive, departure exclusive.
- Holds are claims on a real room. Conversion hold to stay is an in-place `claim_type` change.
- Expired holds are released inside the booking transaction (`release_expired_holds`); an exclusion
  constraint cannot use `now()`, so the cleanup job is only a backstop.
- Guest ID document numbers are not stored in the MVP.
- Tax and service-charge rates are data (`tax_rules`), never constants. The prototype hard-codes 7.5%
  VAT; do not copy that.

## Current state

Built and tested locally (PostgreSQL 16 with stand-ins for Supabase's `auth` schema):

- `supabase/migrations/` 001 tenancy, 002 identity and permissions, 003 inventory, 004 claims
- `supabase/tests/run.sh` runs migrations, `02_claims.sql`, `03_security.sql` and two pgbench races
  (50 clients for 1 room: exactly 1 wins; 100 clients for 5 rooms: exactly 5 win). All pass.
- App shell builds and type-checks: `/` guest placeholder, `/app` (redirects to `/login` when signed out),
  `/login` placeholder, `/platform` placeholder. No sign-in form yet.

Not verified:

- Migrations have not been applied to a real Supabase project.
- The GitHub Actions workflow has not run.
- Nothing has been tested with a real Supabase Auth user or the browser client.
- Paystack, tax, and Nigerian data-protection points in the System Design are from general knowledge
  and need checking against current Paystack docs, a tax adviser and a lawyer.

## Things to know before editing

- **Migration numbering** differs from the design doc's list: claims were built early (004) to prove the
  double-booking protection. Keep filename order = apply order.
- **RLS pattern:** read policies call `has_permission(property_id, 'perm')`; writes to reservations,
  claims, invoices, payments, refunds and audit logs are revoked from `authenticated` and happen only
  through `security definer` functions. Functions that mutate state must check permission themselves.
- **`claim_room` and `release_expired_holds`** are internal: execute is revoked from client roles. Operation
  functions call them. Do not grant them to `authenticated`.
- **room_types holds base rates**, so its read policy requires `reservation.view`, `rate.view` or
  `property.configure`. Housekeeping and maintenance get a purpose-built view later (not built yet).
- **Test harness quirk:** psql `:variables` do not expand inside `$$` blocks, so `02_claims.sql` uses literal
  UUIDs (see `01_seed.sql` for what they are). `run.sh` drops privileges to the `postgres` user when run as root.
- **Seed data** in `01_seed.sql` is test-only. Real roles and permissions are seeded in migration 002.
- **Versions installed:** Next 16, React 19, TypeScript 7, Tailwind 4, zod 4. No `middleware`/`proxy` file yet;
  auth gating is in `app/(staff)/app/layout.tsx` for now. Fonts load from Google Fonts via `<link>`.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY` must only be used in server-only code and Edge Functions.
- The user pushes to GitHub manually; Claude sessions may not have push access.

## Suggested next steps

1. Run `npm install` and `npm run db:test` locally to confirm the same results.
2. Push, confirm CI is green, create a Supabase staging project, apply the four migrations there.
3. Build guests, reservations, `reservation_rooms`, `reservation_nights`, the claims FK and tiling trigger,
   then `create_reservation` with the multi-room and deadlock tests from System Design section 3.
4. Continue down `TODO.md` in phase order; do not start online booking before Phase 3 and 4 gates pass.
