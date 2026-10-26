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
- pgbench races: 50 clients for the last room (exactly 1 wins), 100 clients for 5 rooms (exactly 5 win)

## Migrations so far

| File | Contents |
| --- | --- |
| 001 tenancy | tenants, properties, domains, subscriptions, entitlements |
| 002 identity | profiles, platform_admins, memberships, roles, permissions, `has_permission` |
| 003 inventory | room_types, rooms |
| 004 inventory_claims | stays, holds and blocks in one table with exclusion constraints; `claim_room` |

File numbers here differ from the design doc's list because claims were built early to prove the
double-booking protection. Next: pricing and policies, guests, reservations and reservation rooms,
`create_reservation`, then the money tables. Follow the gates in System Design section 11.

## Status

Foundation only. Screens are placeholders; no sign-in form yet.
