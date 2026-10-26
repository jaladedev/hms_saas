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
- [ ] Guests, reservations, `reservation_rooms`, `reservation_nights` (add the FK from claims to `reservation_rooms`)
- [ ] Tiling trigger: stay claims per reservation room must cover `[arrival, departure)` exactly
- [ ] `create_reservation` (single and multi-room, all-or-nothing) with deadlock retry
- [ ] `create_hold`, `transfer_room`, `create_room_block` with conflict list
- [ ] Concurrency tests for multi-room atomicity, transfer race, deadlock retry (System Design section 3 table)

## Phase 2: Core schema and security
- [ ] Pricing and policy: rate_plans, daily_rates, tax_rules, property_policies (versioned), `resolve_rate`
- [ ] Operations: housekeeping_tasks and history, maintenance_requests, folio_charges
- [ ] Money: invoices, lines, invoice_sequences, payment_attempts, payments, allocations, refunds, payment_events, provider accounts
- [ ] `audit_logs` (insert-only), `idempotency_keys`, `outbox_events`, `notifications`, `documents`, `booking_access_tokens`
- [ ] Operation functions: check_in, check_out, cancel, issue and void invoice, manual payment, verify payment, refund request and approve
- [ ] Reporting views and `refresh_reservation_payment_status`, `guest_booking_status`
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
- [ ] Invoice numbering scheme (per property or per tenant, yearly reset)
- [ ] Revenue definition shown first on dashboard (earned vs cash; both are built)
- [ ] Whether guest ID documents are ever stored (default: no)
- [ ] Theme editor, density settings, bulk actions: in scope or not (default: later)
- [ ] Paystack merchant eligibility, channels, refund support, settlement timing
