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

## Checks

```bash
npm ci
npm ci --prefix tools/lint      # the linter has its own dependencies; `npm run lint` fails with "eslint: not found" without this
npm run typecheck
npm run lint                    # zero warnings allowed
npm test                        # unit tests (vitest)
npm run build
npm run db:test                 # database suite (needs PostgreSQL 16 server binaries; see below)
npm run e2e                     # whole flow over HTTP: the app, PostgREST, PostgreSQL 16 and a fake Paystack
```

The first four run anywhere Node does, and CI runs them (`.github/workflows/ci.yml`). `db:test` and `e2e` start their own
throwaway PostgreSQL cluster, so they need the server binaries (`/usr/lib/postgresql/16/bin`, override with `PGBIN`).
`e2e` also downloads the PostgREST binary to `/tmp` unless `PGRST_BIN` points at one, and builds the app into `.next-e2e`.

## Database tests

`npm run db:test` starts a throwaway PostgreSQL 16 cluster (binaries in
`/usr/lib/postgresql/16/bin`, override with `PGBIN`), applies every migration against stand-ins for
Supabase's `auth` schema, then runs:

- `02_claims.sql`: back-to-back stays, overlaps, stale and live holds, blocks, out-of-service rooms
- `03_security.sql`: cross-tenant reads and writes, role limits, revoked membership, anon
- `04_reservations.sql`: pricing, tax rounding, multi-room, all-or-nothing, idempotency, permissions, online holds, tiling, audit
- `05_operations.sql`: check-in, check-out, transfers, blocks, cancellation
- `21_housekeeping_tasks.sql`: tasks follow the room status, check-out opens one, read access (housekeeping.view), no direct writes, frozen history, create/claim/assign/start/complete/cancel rules, retired rooms, the assignment picker, closed internals; plus two races (20 clients claiming one task: one housekeeper wins; 16 clients mixing room status changes with task start/complete: no deadlock, room and task agree)
- `24_maintenance_requests.sql`: maintenance.view and maintenance.manage grants, reporting (idempotent by key, a room or a place), read access, no direct writes, frozen history, claim/assign/start/resolve/cancel/priority rules, linking a room block (and resolving never releasing it), the assignment picker, closed internals, deleted logins; plus two races (20 clients claiming one request: one technician wins; 20 clients sending the same report with one key: one request, one answer)
- `28_audit_membership_visibility.sql`: an owner sees their group's staff access changes and no other row without a property; a login without audit.view sees none; another hotel group sees only its own; the helper is true only with audit.view in that group and not callable by anon; a real suspension and reinstatement leave rows the owner can read
- `27_audit_actor_names.sql`: names for the audit trail: an owner gets names for their own hotel group only (full name, else email), a login without audit.view gets none, another hotel group gets none of this one's people, a revoked member still resolves, a null or long list is read safely, anon cannot call it
- `26_tax_rule_audit.sql`: tax rule changes are audited (who, old and new values), a save that changes nothing writes nothing, front desk and another hotel change nothing and leave no trace, a fixed-per-night rule cannot be marked for extras
- `25_folio_charges.sql`: folio.charge grants, the tax-rule flag, posting a charge (permissions, input, state, dates, idempotent by key), tax from marked percent rules (compounding, in force that day, stored on the charge), read access, no direct writes, frozen history, payments never above the balance, voiding, reversing a payment (refund.approve), the balance, charges after check-out, deleted logins, and a check that the reservation's own money never moves; plus three races (20 clients paying one balance: one wins; 20 clients posting one charge with one key: one charge; 12 clients posting, paying and voiding at once: no deadlock, never over-paid)
- `13_settlement.sql`: cancellation settlement (fee invoice, stay invoice void, refund requests newest payment first, unpaid charge flag and collection), cancellation email, the one-call refund payout guard
- `12_email_rate_limits.sql`: email outbox (triggers, claim, retry, stuck-worker recovery), link re-issue, rate limits, purge, access limits; plus a claim race (30 workers, 20 emails, each claimed once)
- `11_guest_booking.sql`: public availability search (counts, pricing parity with `create_hold`, filters, host isolation), payment start context, access limits
- `10_webhook_support.sql`: provider account lookup for webhook URLs, refund webhook matching, guest booking status, access limits
- `09_refunds.sql`: refund request and approval (two-person rule), caps, manual and provider payouts, reversal, voiding a refunded invoice, immutability; plus a refund race (20 requests, exactly 1 fits)
- `08_provider_payments.sql`: attempts, `confirm_payment` (success, mismatch, failure, late, expired, room lost, after cancel), sweep, access limits; plus a duplicate-webhook race (20 deliveries, one payment)
- `07_money.sql`: invoice issue, numbering and immutability, manual payments, allocation, overpayment, void, permissions; plus a payment race (20 clients, exactly 5 fit)
- `06_holds.sql`: host resolution, `create_hold` called the way PostgREST calls it (session `authenticator`, role from the JWT), access limits, validation, idempotency, guest reuse, hold caps, expiry
- pgbench races: last room (1 of 50 wins), 5 rooms (5 of 100), the same through `create_reservation`, two-room bookings (2 of 40), the last two through `create_hold`, and a block against website holds and staff bookings for the one room of the solo type (10 rounds of 24 clients: exactly one gets it)

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
| 015 email_and_rate_limits | `email_outbox` filled by triggers, `claim_emails`, `mark_email_result`, `request_booking_link`, `consume_rate_limit`, `purge_old_operational_data` (`service_role` only) |
| 016 settlement_and_payout | cancellation settlement trigger, `reservation_settlement`, `start_refund_payout`, `refund_payout_context`, `note_refund_attention`, `stale_processing_refunds` |
| 017 staff_email_outbox | Staff view of failed guest emails, and resend |
| 018 housekeeping_status | Housekeeping status |
| 019 staff_management | Staff management: who works at the hotel, what they may do, and how that changes |
| 020 update_guest | Editing a guest's contact details, as an audited function |
| 021 payment_no_room_email | Tell the guest when they paid but their room was gone |
| 022 refund_bank_details | Refunds that Paystack cannot finish without the customer's bank details |
| 023 housekeeping_tasks | `housekeeping_tasks` (read under RLS, written only by functions, rows never deleted), permission `housekeeping.assign`; `create_housekeeping_task`, `claim_housekeeping_task`, `assign_housekeeping_task`, `start_housekeeping_task`, `complete_housekeeping_task`, `cancel_housekeeping_task`, `list_housekeeping_staff`; a trigger on `rooms` keeps tasks in step with the cleaning status |
| 024 setup_audit | Audit for hotel setup changes |
| 025 clear_rates_grant | Let rate managers clear nightly prices |
| 026 maintenance_requests | `maintenance_requests` (read under RLS, written only by functions, rows never deleted), permission `maintenance.view`; `report_maintenance_request`, `claim_maintenance_request`, `assign_maintenance_request`, `start_maintenance_request`, `resolve_maintenance_request`, `cancel_maintenance_request`, `set_maintenance_priority`, `link_maintenance_block`, `list_maintenance_staff`; requests never change a room's status or availability |
| 027 folio_charges | `folio_charges` and `folio_payments` (read under RLS by people who post charges and by finance roles, written only by functions, rows never deleted), permission `folio.charge`, `tax_rules.applies_to_charges`; `post_folio_charge`, `void_folio_charge`, `record_folio_payment`, `reverse_folio_payment`, `folio_balance`; the reservation's own invoice, totals and payments are untouched |
| 028 tax_rule_audit | audit trigger on `tax_rules` (who changed which rule, old and new values), reusing 024's `audit_setup_row` |
| 029 audit_actor_names | `audit_actor_names(user_ids)`: display names for the people on a page of the audit trail, only for people in a hotel group where the caller holds `audit.view`; `authenticated` only |
| 030 audit_membership_visibility | `audit_logs_select` also shows rows with no property about a membership (suspend, reinstate, remove) to people with `audit.view` in that hotel group; helper `can_view_tenant_audit(tenant)`; `authenticated` only |
| 031 policy_audit | Audit for policy versions |
| 032 guest_policy | Policy text for the guest booking site, `service_role` only |
| 033 update_reservation_stay | Edit a booking's stay: its dates and how many adults and children are in each room |
| 034 staff_holds | Staff holds: a room held for a guest who has not paid yet, confirmed when staff record the payment |
| 035 guest_cancel | Guests cancel their own booking |
| 035 policy_config_valid | Policy JSON validity: a malformed policy is refused however it is written |
| 036 daily_report | daily_report: one row per day for a property, for the reports screen |
| 037 no_show | No-show: a guest who never arrived |
| 038 guest_cancel_setting | A hotel setting to switch guest self-cancel off |
| 039 room_board_views | Room board views: what the room board needs, without rates or guests |
| 040 occupancy_report | Occupancy report |
| 041 guest_hotel | Hotel identity for the guest site |
| 042 purge_idempotency_keys | Idempotency keys expire |
| 043 policy_date_rules | Policy version dates are enforced by the database |
| 044 channel_guest_reports | Channel and guest reports |
| 045 no_show_reports | No-shows in the reports |
| 046 no_show_list | No-show list |
| 047 config_audit | Audit coverage: platform configuration, and guests can only be changed through the audited function |
| 048 folio_invoices | A numbered invoice for extras |
| 049 email_folio_invoice | Email the invoice for extras to the guest |
| 050 platform_admin | Platform administration and tenant onboarding |
| 051 platform_plans | Plan and feature flags for a hotel group, set by a platform admin |
| 052 report_export_flag | The first feature flag that does something: reports.export |
| 053 online_payments_flag | Second enforced feature flag: online_payments |
| 054 owner_invite | Resend an owner's invitation |
| 055 staff_notifications | Staff notifications: the inbox behind /app/notifications |
| 056 payment_verification | Payment verification |
| 057 fixed_per_stay_tax | A tax or levy that is a fixed amount once per stay (tax_rules.basis = 'fixed_per_stay') |
| 058 discounts | A percentage discount on a booking, capped by role |
| 059 discount_cap_overrides | Discount limits for each hotel, with a screen to change them |
| 060 early_checkout | Early check-out: what happens to the nights a guest does not stay |
| 061 early_checkin | Early check-in: a guest who arrives before their booked arrival date |
| 062 discount_amount | A discount given as a fixed naira amount |
| 063 discounts_flag | Third enforced flag: discounts |
| 064 online_booking_flag | Fourth enforced flag: online_booking |
| 065 discount_with_payments | Discounts on a booking that already has money on it |
| 066 guest_link_reset | Revoking a guest's booking links |
| 067 guest_cancel_flag | Fifth enforced flag: guest_cancel |
| 068 block_cancel_resolution | Blocking a room that has bookings: a third way out, "cancel" |
| 069 guest_change_requests | Guest self-service, part 1: contact details and change requests, from the guest's booking link |
| 070 stay_change_with_money | A date change on a booking that has money on it (guest self-service part 2, step 1) |
| 071 guest_date_change | Guest self-service, part 2: the guest changes the dates of a confirmed booking from their booking link |
| 072 discount_refund_due | A discount may take the price below what the guest has already paid |
| 073 early_checkin_waiver | Early check-in: waiving the added nights |
| 074 early_checkout_email | Email the guest when an early check-out credit is applied |
| 075 guest_changes_flag | Sixth enforced flag: guest_changes |
| 076 early_checkin_flag | Seventh enforced flag: early_checkin |
| 077 room_type_amenities | Amenities on room types |
| 078 transfer_same_type | Room transfers stay within the booking's room type |

File numbers differ from the design doc's list because claims were built early to prove the
double-booking protection. `TODO.md` follows the System Design phase gates (section 11) and says what is done and open;
`HANDOFF.md` records what each migration and screen does.

## Status

Built and tested locally, not yet run for real. As of 2026-11-09 `npm test`, `npm run db:test` and `npm run e2e` pass.

- **Guest site:** search, hold, pay with Paystack, booking status page, and a link by booking reference and email; guests can cancel,
  ask for changes, and change dates when the hotel allows it.
- **Staff app** (sign-in and password reset included): front desk with an arrivals and departures calendar, reservations (new,
  edit, hold, folio, invoices, settlement), room board and room calendar, housekeeping, maintenance, guests, payments and
  reconciliation, refunds, reports, notifications, guest emails, staff and permissions, and settings for room types, rates,
  tax, policies, discounts and setup history.
- **Platform admin** (`/platform`): onboard a hotel group, set its plan and feature flags, resend an owner's invitation.

Not done, and mostly not something code can finish: a real Supabase project and Paystack TEST run (`docs/STAGING.md`), monitoring and a
backup rehearsal, tax and levy rules confirmed by an adviser, a privacy review, and a day of real use with the first hotel. Room
photos and billing the hotels are also open. See `TODO.md`.

## App code so far

Guest booking site (host decides the hotel; nothing tenant-related comes from the browser):
- `/` search by dates and guests, priced room types with how many are left.
- `/reserve` quote and guest details; the server action calls `create_hold` and redirects to `/booking/<token>`.
- `/booking/find` asks for booking reference plus email and emails a fresh link (the answer is the same whether or not anything matched).
- `POST /api/staff/refunds/<id>/payout`: staff (refund.approve, signed-in session, same-origin only) pays an approved provider refund out through Paystack, at most once (`lib/refunds/payout.ts`). The Pay out button on `/app/refunds` calls it.
- `/booking/<token>` booking status, hold countdown, **Pay now** (server action: `create_payment_attempt`, then Paystack initialize, then redirect to checkout). Returning from checkout shows a "confirming your payment" page that refreshes until the webhook has confirmed the booking.
- `app/api/webhooks/paystack/[account]/route.ts`: one webhook URL per provider account. Decision logic lives in `lib/webhooks/paystack.ts` (testable without Next.js or Supabase).
- `lib/email/*` (templates, Resend mailer, outbox drain), `lib/rate-limit.ts`, `lib/maintenance.ts`, and `app/api/cron/maintenance/route.ts` (hold expiry, email backstop, cleanup; call it every few minutes with `Authorization: Bearer $CRON_SECRET`).
- `lib/paystack.ts` (signature check, verify, initialize), `lib/booking-token.ts` (stateless signed links), `lib/provider-secret.ts` (`env:NAME` pointers), `lib/guest-site/*` (formatting, parameters, friendly errors, server calls).
- `npm test` runs the unit tests (vitest). `npm run db:test` runs the database suite. `docs/STAGING.md` is the checklist for the first real Supabase, Resend and Paystack TEST run. `npm run e2e` runs the whole guest flow, then the staff tax rules and setup history screens, against a real Postgres, real PostgREST (signed JWTs) and a fake Paystack; it needs PostgreSQL 16 server binaries and downloads the PostgREST binary to `/tmp` on first run.
- `types/database.ts` holds the TypeScript types of the database (tables, views, functions, enums). It is generated, so do not edit it by hand. Regenerate it after any migration: `npm run db:types` against the linked Supabase project (`supabase link` first), or `npm run db:types:local` against a local stack (`supabase start`, needs Docker). The checked-in file was generated from a local PostgreSQL 16 built from the migrations with the same generator the Supabase CLI uses; regenerating with the CLI may show small formatting differences. The Supabase clients in `lib/supabase/` are not typed with it yet.
