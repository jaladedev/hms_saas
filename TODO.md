# TODO

Order follows the phase gates in the HMS System Design doc (section 11). Tick items as they land.
Each migration ships with its RLS policies, grants and tests; do not merge one without them.

## Phase 0: Foundations
- [x] Next.js 16 + TypeScript + Tailwind 4 app shell, route groups for site, staff, platform
- [x] Supabase clients (browser, server), env validation, `.env.example`
- [x] Local Postgres test harness (`npm run db:test`) and CI workflow
- [ ] Push to GitHub and confirm the CI workflow runs green (both jobs)
- [ ] Create Supabase staging and production projects; check plan limits (connections, PITR, `pg_cron`, `pg_jsonschema`)
- [ ] Link Supabase CLI (`supabase link`), run migrations on staging, confirm they apply on real Supabase
- [ ] Wire `supabase gen types` into a `types/database.ts` file and a script
- [ ] Add lint and formatting (ESLint, Prettier) to CI
- [ ] Extract design tokens and shared components from the prototype (colors, fonts, status badges, tables, room cards)

## Phase 1: Inventory proof
- [x] 001 tenancy, 002 identity and permissions, 003 inventory, 004 room_inventory_claims + `claim_room`
- [x] Concurrency tests: last-room race, type-level race
- [x] Guests, reservations, `reservation_rooms`, `reservation_nights`, FK from claims to `reservation_rooms` (migration 006)
- [x] Tiling trigger: active stay/hold claims per reservation room must cover `[arrival, departure)` exactly (deferred, 006)
- [x] `create_reservation` (single and multi-room, all-or-nothing, idempotent, audited) with advisory locks against deadlocks (007)
- [x] `transfer_room`, `create_room_block` / `release_room_block` with conflict list and optional move (008); all take the advisory lock via `claim_room`
- [x] `create_hold` (host-resolved tenant, `service_role` only, own idempotency, caps per email) and `resolve_host` (009); `session_user` check replaced by `is_system_caller()` so it works behind PostgREST
- [x] `expire_lapsed_holds` sweep (011), now called by `/api/cron/maintenance`; a scheduler must still be configured to call that route
- [x] Guest booking tokens: stateless and signed (`lib/booking-token.ts`), no table needed; `guest_booking_status` (013) returns what a guest may see
- [x] Paystack webhook route with signature check, re-verification and tenant scoping
- [x] Guest booking flow: availability search, reserve, hold, pay (Paystack initialize), status page by token, confirmation after webhook (014 and the pages under `app/(site)`), proven by `npm run e2e`
- [x] Guest emails: hold, confirmation, refund processed and re-issued link, through a durable outbox (015) sent by `lib/email` with Resend; link re-issue at `/booking/find`
- [ ] Staff view of the email outbox (failed emails after 5 attempts need a person) and a resend button
- [ ] Email for cancellation by the hotel, and for a booking flagged `paid_inventory_lost` (the guest is owed an explanation); neither is queued today
- [x] Rate limiting on guest actions (search, hold, pay, link requests) by keyed hash of address, email or reservation (015)
- [ ] Guest site polish: hotel name and branding before a search, photos and amenities for room types, cancellation and payment policy text on the reserve page, a proper not-found page for dead links
- [ ] Dynamic hold length on the countdown (the page shows minutes left only at render time)
- [ ] Refund payout route for staff: `begin_refund_processing`, then Paystack `POST /refund`, then `record_refund_result` (the webhook also reports the result)
- [ ] Staff queue for reservations with `attention_reason` set (payment_amount_or_currency_mismatch, payment_overpayment, paid_inventory_lost, paid_after_cancel)
- [x] Concurrency tests: reservation race for the last room, multi-room race (exactly 2 of 40 two-room requests win), the same two through `create_hold`
- [ ] Concurrency tests still missing: transfer race, block-over-stay through the block function (functional tests exist in 05_operations.sql)

## Phase 2: Core schema and security
- [x] Pricing and policy: rate_plans, daily_rates, tax_rules (percent and fixed per night), property_policies (versioned), `resolve_rate`, `calc_night_tax` (005)
- [ ] Stay-level fixed charges and folio taxes in `tax_rules`; `discount.apply` limits
- [ ] Operations: housekeeping_tasks and history, maintenance_requests, folio_charges
- [x] Money, staff side: invoices, lines, invoice_sequences, payments, allocations (010)
- [x] Money, provider side: payment_attempts, payment_events, payment_provider_accounts, `create_payment_attempt`, `confirm_payment` (011)
- [x] Refunds and payment reversal (012): two-person approval, caps, manual and provider payouts, `partially_refunded` / `refunded`, refunded invoices can be voided
- [ ] Settlement on cancellation and no-show (cancellation charge vs refund) is still not built; `cancel_reservation` does not touch money
- [x] `audit_logs` (insert-only) and `idempotency_keys` (007)
- [ ] `outbox_events`, `notifications`, `documents`, `booking_access_tokens`; idempotency key expiry job
- [x] `cancel_reservation` (policy charge, releases inventory), `check_in` (readiness gate with override), `check_out` (early departure frees the room, marks dirty) (008)
- [x] `issue_invoice`, `void_invoice`, `record_manual_payment` (010)
- [ ] Operation functions still to build: settlement on cancellation, payment verification workflow, early check-in policy, settlement or credit on cancel and early check-out, cancel-resolution for blocks
- [x] `refresh_reservation_payment_status` (010)
- [ ] Reporting views, `guest_booking_status`
- [ ] `room_board_view` and `housekeeping_task_view` for roles that must not read rates or guests
- [ ] Full security suite from System Design 6.3, including refund requester != approver and property-scoped roles
- [ ] Guard against role escalation: granting requires holding the role's permissions plus `staff.manage`; last owner cannot be removed

## Phase 3: Staff MVP (UI)
- [ ] Sign in, forgot and reset password, staff invitation
- [ ] Setup wizard, room types and rooms, rates and policies
- [ ] Reservation list, create (single and multi-room), details, walk-in
- [ ] Front desk, room board, check-in and check-out, room transfer
- [ ] Guests, manual payments, invoices, housekeeping, staff and permissions
- [ ] Hotel runs one full real day in staging with no spreadsheet fallback

## Phase 4: Hardening and launch
- [ ] Audit coverage review; monitoring and alerts (System Design 9.5)
- [ ] Backup restore rehearsal; record the real recovery point and time for the plan
- [ ] Tax and levy rules confirmed by a qualified Nigerian adviser
- [ ] Privacy review and data-processing agreement with the hotel; incident runbook and tabletop
- [ ] User acceptance with the first hotel

## Phase 5: Online booking and Paystack
- [ ] `tenant_domains` host resolution on the guest site
- [ ] Guest flow: search, details, optional room selection, review, payment, confirmation, lookup, status
- [ ] Payment initiation, signed webhook Edge Function, verification, idempotent `confirm_payment`
- [ ] Paid-but-no-room recovery, refunds, reconciliation import
- [ ] Payment test matrix (duplicate, out-of-order, wrong amount, wrong currency, delayed webhook)

## Phase 6 and 7
- [ ] Calendars, room blocks UI, maintenance, reports, notifications, self-service booking management
- [ ] Platform admin, tenant onboarding, entitlements, subscriptions, multi-property switching

## Decisions still open
- [ ] Hold duration (start 15 to 30 minutes, watch `inventory_lost` count)
- [ ] Invoice numbering scheme: built as per property, yearly reset (`INV-<code>-<year>-<6 digits>`); confirm with the hotel's accountant
- [ ] Revenue definition shown first on dashboard (earned vs cash; both are built)
- [ ] Whether guest ID documents are ever stored (default: no)
- [ ] Theme editor, density settings, bulk actions: in scope or not (default: later)
- [ ] Paystack merchant eligibility, channels, refund support, settlement timing
