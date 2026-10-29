# HMS: Hotel Management System

Multi-tenant hotel management SaaS. First customer: a boutique hotel in Ibadan, Nigeria.
Stack: Next.js (App Router) + TypeScript + Tailwind, Supabase (Postgres, Auth, Storage), Paystack.

Design documents: `docs/specs/` holds the original DB and UI specs. The system design
(architecture, schema, inventory SQL, operations, payments, RLS, delivery plan) lives in the
"HMS System Design" doc; the review of the specs lives in "HMS Spec Review and Implementation Plan".

## Rules that shape the code

1. Screens and route handlers never write inventory or money tables directly. They call database
   functions that do the whole operation in one transaction.
2. Tenant and property come from the signed-in user's membership (staff) or the request host
   (guests), never from a form field or URL.
3. Money is `bigint` kobo. Paystack amounts are converted in one tested place.
4. Every migration ships with its RLS policies, grants and tests.
5. The service-role key stays in server-only code and Edge Functions.

## Layout

```
app/(site)/        Guest booking site (Phase 5)
app/(staff)/app/   Staff dashboard, requires sign-in
app/platform/      Platform administration (Phase 7)
lib/supabase/      Browser and server clients
supabase/migrations/  Versioned SQL, applied in filename order
supabase/tests/       Local Postgres harness: migrations, security and concurrency tests
docs/specs/        Original specifications
```

## Run

```bash
cp .env.example .env.local      # fill in Supabase URL, publishable key, service role key
npm install
npm run dev
```

## Database tests

`npm run db:test` starts a throwaway PostgreSQL 16 cluster (binaries in
`/usr/lib/postgresql/16/bin`, override with `PGBIN`), applies every migration against stand-ins for
Supabase's `auth` schema, then runs:

- `02_claims.sql`: back-to-back stays, overlaps, stale and live holds, blocks, out-of-service rooms
- `03_security.sql`: cross-tenant reads and writes, role limits, revoked membership, anon
- `04_reservations.sql`: pricing, tax rounding, multi-room, all-or-nothing, idempotency, permissions, online holds, tiling, audit
- `05_operations.sql`: check-in, check-out, transfers, blocks, cancellation
- `11_guest_booking.sql`: public availability search (counts, pricing parity with `create_hold`, filters, host isolation), payment start context, access limits
- `10_webhook_support.sql`: provider account lookup for webhook URLs, refund webhook matching, guest booking status, access limits
- `09_refunds.sql`: refund request and approval (two-person rule), caps, manual and provider payouts, reversal, voiding a refunded invoice, immutability; plus a refund race (20 requests, exactly 1 fits)
- `08_provider_payments.sql`: attempts, `confirm_payment` (success, mismatch, failure, late, expired, room lost, after cancel), sweep, access limits; plus a duplicate-webhook race (20 deliveries, one payment)
- `07_money.sql`: invoice issue, numbering and immutability, manual payments, allocation, overpayment, void, permissions; plus a payment race (20 clients, exactly 5 fit)
- `06_holds.sql`: host resolution, `create_hold` called the way PostgREST calls it (session `authenticator`, role from the JWT), access limits, validation, idempotency, guest reuse, hold caps, expiry
- pgbench races: last room (1 of 50 wins), 5 rooms (5 of 100), the same through `create_reservation`, two-room bookings (2 of 40), and the last two through `create_hold`

## Migrations so far

| File | Contents |
| --- | --- |
| 001 tenancy | tenants, properties, domains, subscriptions, entitlements |
| 002 identity | profiles, platform_admins, memberships, roles, permissions, `has_permission` |
| 003 inventory | room_types, rooms |
| 004 inventory_claims | stays, holds and blocks in one table with exclusion constraints; `claim_room` |
| 005 pricing | rate plans, daily rates, tax rules, versioned policies, `resolve_rate`, `calc_night_tax` |
| 006 reservations | guests, reservations, reservation rooms and nights, claims FK, deferred tiling trigger |
| 007 create_reservation | audit_logs (append-only), idempotency_keys, `create_reservation` (single and multi-room) |
| 008 reservation_operations | `cancel_reservation`, `check_in`, `check_out`, `transfer_room`, `create_room_block`, `release_room_block`; `claim_room` now takes the advisory lock itself |
| 009 create_hold | `resolve_host(host)`, `create_hold(host, arrival, departure, rooms, guest, key)`; both `service_role` only |
| 010 invoices_payments | invoices, invoice_lines, invoice_sequences, payments, payment_allocations; `issue_invoice`, `void_invoice`, `record_manual_payment`, status refresh helpers |
| 011 provider_payments | payment_provider_accounts, payment_attempts, payment_events; `create_payment_attempt`, `confirm_payment`, `expire_lapsed_holds` (all `service_role` only) |
| 012 refunds | refunds; `request_refund`, `approve_refund`, `record_manual_refund`, `reverse_payment`; provider side `begin_refund_processing`, `record_refund_result` (`service_role` only); statuses follow money held |
| 013 webhook_support | `payment_provider_account_for_webhook`, `find_processing_refund`, `guest_booking_status` (`service_role` only); `confirm_payment` gained a tenant scope |
| 014 guest_booking_support | `search_availability(host, arrival, departure, adults, children)`, `payment_start_context(reservation)` (`service_role` only) |

File numbers differ from the design doc's list because claims were built early to prove the
double-booking protection. Next: the booking site (search, hold, pay, status pages), staff UI, and a scheduler for `expire_lapsed_holds`. Built so far on the app side: the Paystack webhook route and guest booking tokens. Follow the gates in System Design section 11.

## Status

Foundation only. Screens are placeholders; no sign-in form yet.

## App code so far

Guest booking site (host decides the hotel; nothing tenant-related comes from the browser):
- `/` search by dates and guests, priced room types with how many are left.
- `/reserve` quote and guest details; the server action calls `create_hold` and redirects to `/booking/<token>`.
- `/booking/<token>` booking status, hold countdown, **Pay now** (server action: `create_payment_attempt`, then Paystack initialize, then redirect to checkout). Returning from checkout shows a "confirming your payment" page that refreshes until the webhook has confirmed the booking.
- `app/api/webhooks/paystack/[account]/route.ts`: one webhook URL per provider account. Decision logic lives in `lib/webhooks/paystack.ts` (testable without Next.js or Supabase).
- `lib/paystack.ts` (signature check, verify, initialize), `lib/booking-token.ts` (stateless signed links), `lib/provider-secret.ts` (`env:NAME` pointers), `lib/guest-site/*` (formatting, parameters, friendly errors, server calls).
- `npm test` runs the unit tests (vitest). `npm run db:test` runs the database suite. `npm run e2e` runs the whole guest flow against a real Postgres, real PostgREST (signed JWTs) and a fake Paystack; it needs PostgreSQL 16 server binaries and downloads the PostgREST binary to `/tmp` on first run.
