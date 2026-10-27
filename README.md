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

File numbers differ from the design doc's list because claims were built early to prove the
double-booking protection. Next: the Next.js layer (booking site, Paystack webhook route, staff UI), with `booking_access_tokens` and a scheduler for `expire_lapsed_holds`. Follow the gates in System Design section 11.

## Status

Foundation only. Screens are placeholders; no sign-in form yet.
