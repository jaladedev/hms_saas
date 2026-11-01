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
- [ ] Add lint and formatting (ESLint, Prettier) to CI. Tried 2026-11-01: `eslint-config-next` 16.4.3 refuses to load on TypeScript 7.0 (typescript-eslint does not support it yet). Options: wait for typescript-eslint support, or run it against a side-by-side TypeScript 6 install. Prettier would rewrite most files, so agree a config that matches the current style first
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
- [x] Staff view of the email outbox (`/app/emails`: failed and retrying emails, resend; migration 017)
- [x] Email for cancellation by the hotel (016) and for a booking flagged `paid_inventory_lost` (021, `payment_no_room`: payment received, no need to pay again, the hotel will arrange another room or a full refund). Not emailed: `paid_after_cancel`
- [x] Rate limiting on guest actions (search, hold, pay, link requests) by keyed hash of address, email or reservation (015)
- [ ] Guest site polish: hotel name and branding before a search, photos and amenities for room types, cancellation and payment policy text on the reserve page. Done: a not-found page for dead booking links (`app/(site)/not-found.tsx`)
- [ ] Dynamic hold length on the countdown (the page shows minutes left only at render time)
- [x] Refund payout route for staff: `begin_refund_processing`, then Paystack `POST /refund`, then `record_refund_result` (the webhook also reports the result). Built as `/api/staff/refunds/<id>/payout` (see Phase 2)
- [x] Staff queue for reservations with `attention_reason` set (payment_amount_or_currency_mismatch, payment_overpayment, paid_inventory_lost, paid_after_cancel): "Needs attention" filter on `/app/reservations`, a badge per row, the explanation on the booking page, and a count on the overview that links to the filtered list
- [x] Concurrency tests: reservation race for the last room, multi-room race (exactly 2 of 40 two-room requests win), the same two through `create_hold`
- [x] Concurrency tests for transfers (4 guests into the last free room; 8 clients moving 4 guests) and for blocks (12 clients on a free room; 12 clients on a room with a guest, resolution `move`). `run.sh` now also fails when a `pgbench` client aborts on an unhandled error, which it used to ignore. Still missing: a race between a block and a new hold or reservation on the same room

## Phase 2: Core schema and security
- [x] Pricing and policy: rate_plans, daily_rates, tax_rules (percent and fixed per night), property_policies (versioned), `resolve_rate`, `calc_night_tax` (005)
- [ ] Stay-level fixed charges and folio taxes in `tax_rules`; `discount.apply` limits
- [x] Operations, housekeeping: `housekeeping_tasks` with assignment, priority, due time and history (migration 023). The screen at `/app/housekeeping` now works from it (Phase 3)
- [x] Operations, maintenance: `maintenance_requests` with reporting, assignment, priority, resolution and an optional link to a room block (migration 026). No screen on it yet (see Phase 3)
- [ ] Operations, still to build: folio_charges
- [x] Money, staff side: invoices, lines, invoice_sequences, payments, allocations (010)
- [x] Money, provider side: payment_attempts, payment_events, payment_provider_accounts, `create_payment_attempt`, `confirm_payment` (011)
- [x] Refunds and payment reversal (012): two-person approval, caps, manual and provider payouts, `partially_refunded` / `refunded`, refunded invoices can be voided
- [x] Settlement on cancellation (016): stay invoice voided, cancellation-charge invoice, refund requests for the surplus, unpaid charge flagged and collectable
- [x] Refund payout route (`/api/staff/refunds/<id>/payout`), at most one Paystack call per refund; unknown outcomes are flagged and listed by maintenance
- [ ] No-show settlement: `no_show` is not settled the way `cancelled` is (no charge, invoice or refund handling); decide the rule with the hotel
- [x] Resolve Paystack `refund.needs-attention` (migration 022): the refund is marked and its Paystack refund id kept; `/app/refunds` shows an "Enter bank details" form (bank list from Paystack, account number reviewed before sending); the details go to `POST /refund/retry_with_customer_details/<id>` at most once per attempt (a refusal frees it, an unclear answer keeps it used); the account number is never stored, logged or returned
- [ ] Check the bank-details retry against Paystack TEST mode before using it with real money: the bank list response (`id`, `name`) and the `bank_id` the retry expects were taken from Paystack's docs and not confirmed with a live call; add a case to `npm run e2e` with the fake Paystack
- [x] Staff screens for money: refund queue (`/app/refunds`: request, approve or reject, manual and Paystack payout, needs-a-person list), settlement summary per cancelled booking (`/app/reservations/<id>/settlement`), and cancellation-charge collection (the charge due shows as the outstanding amount on the booking page, where a payment is recorded).
- [ ] Guests cannot cancel their own booking (staff cancel on their behalf); a guest-facing cancel needs the same settlement preview before they confirm
- [x] `audit_logs` (insert-only) and `idempotency_keys` (007)
- [ ] `outbox_events`, `notifications`, `documents`, `booking_access_tokens`; idempotency key expiry job
- [x] `cancel_reservation` (policy charge, releases inventory), `check_in` (readiness gate with override), `check_out` (early departure frees the room, marks dirty) (008)
- [x] `issue_invoice`, `void_invoice`, `record_manual_payment` (010)
- [ ] Operation functions still to build: settlement on cancellation, payment verification workflow, early check-in policy, settlement or credit on cancel and early check-out, cancel-resolution for blocks
- [x] `refresh_reservation_payment_status` (010)
- [ ] Reporting views, `guest_booking_status`
- [ ] `room_board_view` for roles that must not read rates or guests (a `housekeeping_task_view` is not needed: tasks hold no guest or rate data and are readable with `housekeeping.view`)
- [ ] Full security suite from System Design 6.3, including refund requester != approver and property-scoped roles
- [x] Guard against role escalation (migration 019): giving, removing or suspending needs every permission of the role at a covering scope plus tenant-wide `staff.manage`; nobody changes their own access; the last active owner cannot be removed or suspended; revoking clears roles

## Phase 3: Staff MVP (UI)
- [ ] Maintenance screens (`/app/maintenance`, `/app/maintenance/[id]`): dashboard (open, high priority, mine, overdue, resolved), a report form on the room card for front desk and housekeeping, claim/start/resolve/cancel for technicians, the assignment picker (`list_maintenance_staff`), the room block link, and a warning from `resolve_maintenance_request` (`block_still_active`) that the room is still out of sale. A maintenance indicator on the room card and room board reads `maintenance_requests` with `maintenance.view`
- [x] Housekeeping screen on tasks (`/app/housekeeping`: my tasks, tasks nobody has, tasks with others, done in the last 24 hours; take, start, finish with a note; supervisors (`housekeeping.assign`) get an assignment picker from `list_housekeeping_staff` and cancel with a reason; anyone with `housekeeping.update` can add a task; dirty rooms with no task get a "Create cleaning task" button). A room's last five tasks (30 days) show under "Housekeeping history" on its card at `/app/rooms`. The add form takes an optional due time (hotel time) and supervisors can filter the list by person (`?who=`)
- [x] Sign in, forgot and reset password
- [x] Staff and permissions (`/app/staff`, owner only): list with roles, invite by email (Supabase invite for new people), add or remove a role per property, suspend, restore, remove. Not built: custom roles, editing a role's permissions, a staff member's own profile page, platform-admin tools
- [x] Room types and rooms setup (`/app/settings/rooms`: add types and rooms, put a room in or out of service or retire it; direct writes under row-level security, audited by triggers from migration 024)
- [x] Rates setup (`/app/settings/rates`: create the standard rate plan, set or clear a nightly price for a date range per room type)
- [x] Editing and switching off room types (`/app/settings/rooms`: change name, description, capacity, standard price and the "bookable online" box; "Switch off" stops new bookings by staff and online while existing bookings and the rooms stay; the code and web address never change; a rename onto another type's name is refused; proven in `22_room_type_status.sql`; no migration, plain updates under row-level security)
- [ ] Tax rules, cancellation and payment policies, first-run wizard
- [x] Audit setup changes (migration 024): every change to a room type, room, rate plan or nightly price is recorded in `audit_logs` with who made it and what changed (old and new values for edits; one summary row per statement for nightly prices: `rates.set`, `rates.changed`, `rates.cleared`, filed against the room type). Triggers, so the screens, scripts and functions are all covered; unchanged saves write nothing. Tested in `23_setup_audit.sql`
- [x] Clearing nightly prices failed with "permission denied" on a real database (migration 005 had revoked DELETE on `daily_rates`, while `clearRates` deletes as the staff member); fixed by migration 025, which grants DELETE on `daily_rates` only (the rate.manage policy still applies)
- [ ] Show the setup audit trail to people with `audit.view` (a screen; the data is in `audit_logs` now)
- [x] Reservation list (`/app/reservations`: search by reference, guest name, email or phone; status, attention and arrival-date filters; paged) and details (`/app/reservations/[id]`: rooms with assigned room number and cleanliness, money summary, cancel, per-room check-in with override reason, per-room check-out, manual payment)
- [x] Reservation create for walk-in and phone bookings (`/app/reservations/new`, one room per booking, default rate plan, confirmed at once)
- [ ] Multi-room create, a chosen physical room, edit dates and guests, staff-created holds that wait for payment
- [x] Invoice issue and void on the details page
- [x] Room transfer, on the booking page (`Move to another room` under each room: same room type only so the price is unchanged, a chosen free room or the first free one, from a chosen date; all or nothing, reason required, audited). Moving to a different room type (upgrade or downgrade with a price change) is not built
- [x] Overview (`/app`: arriving, departing and in-house counts for today, then a "needs a person" list that links to the right screen: overdue departures, flagged reservations, stuck refund payouts, refunds to approve or pay out, failed guest emails, late arrivals; nothing at zero is shown)
- [x] Front desk board (`/app/front-desk`: arrivals, departures, in house, overdue departures, late arrivals; each links to the booking)
- [x] Room board (`/app/rooms`, read-only: state of every room today, occupant, blocks, next booking; each room card can set its cleaning status (migration 018) and block or unblock it; a block that would clash with a booking is refused and the booking has to be moved first)
- [x] Guests (`/app/guests`: search by name, email or phone; guest page with stay history and an audited contact-details edit, migration 020). Not built: merging duplicate guests, guest notes or preferences, a guest's invoices and payments in one view
- [x] Housekeeping screen (`/app/housekeeping`: rooms to clean, most urgent first, one button per room; reads only rooms and claims, so it works for roles that cannot see guests or rates; now linked from the sidebar). Superseded by the task screen above
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
