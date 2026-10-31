# Handoff

Last updated: 2026-10-31 (cancellation settlement and refund payout: 016). Read this first, then `TODO.md`.

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

- `supabase/migrations/` 001 tenancy, 002 identity and permissions, 003 inventory, 004 claims,
  005 pricing (rate plans, daily rates, tax rules, versioned policies, `resolve_rate`, `calc_night_tax`),
  006 guests, reservations, reservation_rooms, reservation_nights, claims FK, deferred tiling trigger,
  007 audit_logs, idempotency_keys and `create_reservation(property, guest, source, arrival, departure, rooms, idempotency_key)`
  008 reservation operations: `cancel_reservation(id, reason, key)`, `check_in(rr, override_reason)`, `check_out(rr, note)`, `transfer_room(rr, target_room, effective_date, reason, key)`, `create_room_block(room, start, end, reason, 'fail'|'move', key)`, `release_room_block(id)`. Helpers: `require_permission`, `property_today`, `idem_begin/finish`, `write_audit`.
  Locking rule: `claim_room` takes `lock_room_types` itself (concurrent inserts into the exclusion constraint can deadlock); any function that claims inventory inherits it.
  009 online entry point: `resolve_host(host)` (verified `tenant_domains` only; a tenant-wide domain resolves only if the tenant has exactly one active property) and `create_hold(host, arrival, departure, rooms, guest, key)`. Both are executable by `service_role` only, so the Next.js server must call them with the service-role key from server-only code, passing the real request Host header, and should rate-limit by IP first. `create_hold` finds or creates the guest by email, ignores any `rate_plan_id` from the caller, caps stays at 30 nights, booking horizon at 365 days, 5 rooms per hold and 3 live holds per email, has its own idempotency key, and returns no internal ids. A replayed response is returned as stored, so check `hold_expires_at`.
  010 money, staff side: `issue_invoice(reservation, key)` copies the reservation nights into invoice lines (totals must match the reservation or it raises); `void_invoice(invoice, reason, key)` (`invoice.void`; refused when the invoice has payments, since reversal and credit notes do not exist yet); `record_manual_payment(reservation, amount, method, reference, note, key)` (`payment.record`; methods cash, bank_transfer, pos, other). Payments belong to the reservation, are allocated to the live invoice (oldest payment first) and are picked up when an invoice is issued later. Overpayment is refused; cancelled, expired and no-show reservations refuse payments until settlement exists. Reservation `payment_status` is recomputed from payments, and only moves between unpaid, partially_paid and paid (failed and refund states are left for 011). Every function locks the reservation row, so payments and invoices for one reservation are serialised. Invoices, lines, payments and allocations are immutable to everyone, the table owner included (triggers); clients can read them only with `invoice.issue`, `payment.record` or `report.view`.
  011 provider payments (Paystack), all functions `service_role` only. `create_payment_attempt(reservation, key)` decides the amount itself (pending online reservation: `policy_snapshot.online_payment` deposit percent or the full total, less what is paid; confirmed: the balance), requires an active `payment_provider_accounts` row and a live hold, and does not extend the hold. `confirm_payment(provider, event_id, event_type, reference, status, amount, currency, channel, payload)` must only ever be called with values the webhook route has verified (HMAC-SHA512 signature on the raw body, then Paystack's verify endpoint). It is idempotent per (provider, event id); amount or currency mismatch records no money and sets `needs_attention`; real money is always recorded; a pending or expired reservation is confirmed by converting holds to stays in place or re-claiming the same room, then any room of the type; if none is free the reservation keeps its status with `attention_reason = 'paid_inventory_lost'`; payments after cancellation are flagged `paid_after_cancel`. `expire_lapsed_holds(limit)` expires abandoned online reservations (no live hold, no attempt started in the last 30 minutes) and needs a scheduler.
  012 refunds. `request_refund` (refund.request) then `approve_refund` (refund.approve, and the approver must not be the requester: SELF_APPROVAL); rejection needs a note. A refund is capped by the payment less every live refund (requested, approved, processing, succeeded); a failed or rejected one frees its amount. Manual payments are paid out by staff and recorded with `record_manual_refund`; provider payments go `begin_refund_processing` (service_role, returns what the provider call needs and is repeatable) then the provider refund API, then `record_refund_result(provider, event id, refund, succeeded|failed, ...)` (idempotent per event, ignored unless the refund is processing). `reverse_payment` undoes a manual payment recorded by mistake (refund.approve; refused with live refunds). Money held = succeeded payments minus succeeded refunds (`reservation_money_held`); reservation payment_status (paid, partially_paid, partially_refunded, refunded, unpaid) and invoice status derive from it, and overpayment checks in 010 and 011 now use it, so a refunded guest can pay again. A paid invoice can be voided once money held is zero. Allocations stay as history only and can exceed money held after a refund; do not use them for balances. Cancellation does not yet create a charge or a refund: that settlement is not built.
  013 webhook support (service_role only): `payment_provider_account_for_webhook(account id)` returns tenant and secret_reference for active accounts of active tenants; `find_processing_refund(tenant, provider, transaction reference, amount)` matches the oldest processing refund; `guest_booking_status(reservation)` returns a guest-safe summary. `confirm_payment` takes an optional `p_tenant_id`: the route passes the tenant of the account that signed the event, so references of other tenants are simply not found.
  014 guest booking support (service_role only): `search_availability(host, arrival, departure, adults, children)` lists public, active room types that fit the party and have a free room for every night (expired holds do not block; stays and blocks do), priced with the same functions `create_reservation` uses, so a quote equals what `create_hold` charges (tested); `payment_start_context(reservation)` returns the tenant's active Paystack account pointer and the guest's email. 009 was tightened in place: `create_hold` accepts only public, active room types and ignores any physical room the caller names.
  Guest pages (`app/(site)`): `/`, `/reserve`, `/booking/[token]`. The host (`x-forwarded-host`, else `host`) is the only thing that picks the hotel. Booking pages are `noindex` and send no Referer because the link is a credential. Server actions: `reserveAction` (create_hold, token valid 3 days, form key makes a double submit idempotent) and `payAction` (create_payment_attempt then Paystack initialize; the amount comes from the database; the idempotency key is per page render, so resubmitting a stale form hits Paystack's duplicate-reference error and the guest reloads for a new attempt).
  End-to-end test (`npm run e2e`, `e2e/`): real Postgres with all migrations, real PostgREST 16.5 with HS256 JWTs, the real Next.js app built into `.next-e2e`, and a fake Paystack. It submits the actual server-action forms over HTTP and covers search, reserve, hold, pay, checkout redirect (reference, kobo amount, email, callback URL), the waiting page, the signed webhook, a replay, a wrong signature, an unknown account, a tampered token, and PostgREST access control (service_role accepted; anon, authenticated and a wrongly signed token refused). It proves `is_system_caller()` works behind PostgREST with a service_role JWT. It does NOT prove it works with Supabase's newer `sb_secret_...` keys; check that on staging.
  015 emails and rate limits (service_role only). `email_outbox` rows are written by triggers in the same transaction as the change (website bookings only): `booking_held` on insert, `booking_confirmed` when a pending or expired reservation becomes confirmed, `refund_processed` when a refund succeeds, `booking_link` from `request_booking_link(host, reference, email)`. A refused or rolled-back change leaves no email. `claim_emails(n)` claims exclusively (FOR UPDATE SKIP LOCKED), returns each email with the guest-safe booking summary and the hotel's verified domain; `mark_email_result` retries with backoff (5, 10, 15, 20 minutes) up to 5 attempts, then `failed`; a row stuck in `sending` for 10 minutes is claimed again. The Resend request carries the outbox id as `Idempotency-Key`, so a reclaim after a crash cannot double-send. The email never contains the token as data: the app mints a signed 7-day link at send time (`lib/email`), on the domain the database returns. `consume_rate_limit(key, limit, window)` is a fixed-window counter; the app keys it with an HMAC of the client address, email or reservation id (`lib/rate-limit.ts`), so raw addresses are never stored. Limits: search 120 per 10 minutes per address; hold 10 per hour per address and 6 per hour per email; pay 10 per hour per address and 6 per hour per reservation; link request 5 per hour per address and 3 per hour per email. A database failure fails the action closed.
  Sending: `lib/email/server.ts drainNow(limit)` runs after a hold, after a handled webhook and after a link request (via `after()`, best effort), and `/api/cron/maintenance` is the backstop. If `RESEND_API_KEY` and `EMAIL_FROM` are missing the outbox is left alone (mail waits), unless `EMAIL_TRANSPORT=log`. The maintenance route also runs `expire_lapsed_holds` and `purge_old_operational_data`; it needs a scheduler that sends `Authorization: Bearer $CRON_SECRET` every 2 to 5 minutes (for example `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/maintenance` from cron, or Vercel Cron, which sends that header itself when `CRON_SECRET` is set).
  016 settlement and payout. When a reservation becomes `cancelled`, a trigger (same transaction as `cancel_reservation`) runs `settle_cancelled_reservation`: it voids the stay invoice (even if money was paid: the stay no longer happens; this is the one exception to `void_invoice` refusing paid invoices), issues a "Cancellation charge (tax included)" invoice for `cancellation_charge_minor` and allocates held money to it oldest payment first, and creates refund REQUESTS for money held beyond the charge, newest payment first (card money goes back to the card), in the canceller's name, still needing a second person's approval. If less is held than the charge, `attention_reason = 'cancellation_charge_unpaid'` is set and clears itself once the charge is covered; `record_manual_payment` accepts payments on a cancelled reservation up to the charge. "Paid" on a cancelled reservation means the charge is covered. Allocation history on voided invoices no longer blocks reuse of the same money (`allocate_payments_to_invoice` and the allocation check count live invoices only). `reservation_settlement(reservation)` (finance staff or the server) reports charge, held, refunds in flight, refunded, refund still to request, charge due and `settled`. Website guests get a `booking_cancelled` email with the charge and refund due; no payout date is promised. 010 and 012 were edited in place for this (unapplied): `record_manual_payment` uses `refresh_money_state`, and the refund status target for cancelled reservations is the charge.
  Refund payout: Paystack's `POST /refund` has no idempotency key, so a duplicate call can refund twice. `start_refund_payout` (signed-in staff with refund.approve) and `begin_refund_processing` (server) move approved to processing and return `call_allowed = true` to exactly ONE caller (`provider_call_started_at`). `lib/refunds/payout.ts` calls Paystack only when allowed. A 4xx other than 429, or no provider configured, marks the refund failed (frees the amount). Timeouts, 429, 5xx and odd responses are UNKNOWN outcomes: the refund stays `processing` with an `attention_note`, nothing retries, and `/api/cron/maintenance` lists refunds processing for over 2 hours (`staleRefunds`, also logged as a warning) for a person to check on Paystack's dashboard and settle. `refund.processed` / `refund.failed` webhooks are the normal way the result arrives. `refund.needs-attention` only adds a note.
  Webhook route (`app/api/webhooks/paystack/[account]/route.ts`, logic in `lib/webhooks/paystack.ts`): finds the account, resolves the secret from `secret_reference` (form `env:NAME`, so each hotel needs its own environment variable), checks `x-paystack-signature` over the raw body, then for `charge.success` calls Paystack's verify endpoint and passes the verified amount, currency and channel to `confirm_payment`. Event id is `charge.success:<transaction id>`. Pending transactions answer 503 so Paystack retries; unverifiable or contradicted events answer 200 and do nothing; database or Paystack failures answer 500. `refund.processed` and `refund.failed` find the processing refund by transaction reference and amount and call `record_refund_result`; `refund.pending`, `refund.processing` and other events are acknowledged.
  Guest booking tokens: `lib/booking-token.ts`, stateless HMAC with expiry, secret in `BOOKING_TOKEN_SECRET`. They cannot be revoked, so keep them short-lived and re-issue from booking reference plus email.
  Tests: 05_operations.sql covers all operations; 06_holds.sql covers 009; 07_money.sql covers 010; 08_provider_payments.sql covers 011; 09_refunds.sql covers 012; 13_settlement.sql covers 016; 10_webhook_support.sql covers 013; 11_guest_booking.sql covers 014; 12_email_rate_limits.sql covers 015. Unit tests (`npm test`, vitest) cover the signature check, verify call, webhook decisions and tokens. Known gaps: no settlement on cancel or early check-out (needs money tables), no early check-in policy, no transfer race test, no block-over-stay race test.
- `supabase/tests/run.sh` runs migrations, `02_claims.sql` to `13_settlement.sql` and ten
  pgbench races: 50 clients for 1 room (1 wins), 100 for 5 rooms (5 win), the same two through
  `create_reservation`, plus 40 clients each requesting 2 of 5 rooms (exactly 2 win, no partial bookings);
  the last room race and the two-room race are repeated through `create_hold`; 20 clients paying a fifth of a total (exactly 5 fit); one Paystack webhook delivered 20 times at once (one payment); 20 refund requests against one payment (exactly one fits); and 30 email workers over 20 pending emails (each claimed exactly once).
  Any pgbench client error fails the run. All pass.
- App shell builds and type-checks: `/` guest placeholder, `/platform` placeholder. Staff sign-in works in code:
  `/login` (email and password through Supabase Auth, `lib/staff/auth-actions.ts`), sign-out in the `/app` sidebar, and
  `proxy.ts` refreshes the session cookie and sends signed-out visitors to `/login?next=...` (`next` is limited to `/app` paths).
  A correct password also needs an active `tenant_memberships` row. Checked on a real build: the redirect, the page and the
  open-redirect guard. NOT checked against a live Supabase Auth project.
  Password recovery: `/forgot-password` (same answer whether or not the email has an account), the link lands on `/auth/callback`
  (exchanges the code for a session, then `/reset-password`), and `/reset-password` sets the new password (10+ characters, at most
  72 bytes) and signs the account out everywhere. Supabase setup needed: add `https://<site>/auth/callback` to Auth > URL
  Configuration > Redirect URLs, and set Site URL. The default link only works in the browser that asked for it (PKCE); to make it
  work from a phone too, change the Reset Password email template's link to
  `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`.

Not verified:

- Migrations have not been applied to a real Supabase project.
- The GitHub Actions workflow has not run.
- Nothing has been tested with a real Supabase Auth user or the browser client.
- Paystack, tax, and Nigerian data-protection points in the System Design are from general knowledge
  and need checking against current Paystack docs, a tax adviser and a lawyer.

## Things to know before editing

- **Deadlocks are real.** Without locks, concurrent multi-room bookings deadlocked (36 of 40 clients exhausted
  three retries). `create_reservation` now takes `pg_advisory_xact_lock` per (property, room type) in sorted
  order before claiming rooms. Any new function that claims rooms (`transfer_room`, `create_room_block`,
  online holds) must take the same lock. The exclusion constraint remains the final referee.
- **create_reservation rules:** staff (`reservation.create`) can book any source except `website`; `website`
  bookings are only allowed for the system (no JWT user, session user `postgres`/`service_role`) and create a
  `pending` reservation with a `hold` claim (`hold_minutes` from policy, default 20). Staff bookings are
  `confirmed` with `stay` claims. There is no client-facing online-booking RPC yet.
- **Idempotency:** same key and same request returns the stored result; same key with a different request raises
  `IDEMPOTENCY_MISMATCH`. The key row rolls back with the transaction, so failed calls can be retried.
- **Tiling trigger** runs at commit as `security definer`, so it sees all claims regardless of the caller's RLS.
- **`session_user` is not a safe "is this the server?" test on Supabase.** PostgREST connects as `authenticator` and switches role per request, so `session_user` never equals `service_role`. Use `is_system_caller()` (defined in 007): no signed-in user AND (direct `postgres`/`supabase_admin` session OR verified JWT role claim `service_role`). `06_holds.sql` reproduces the PostgREST shape with `set session authorization authenticator` plus `set role service_role`. Still not tried against a real project.
- **Lapsed holds:** `release_expired_holds` marks the claim expired when someone next claims overlapping dates, but the reservation row stays `pending`. A sweep that sets it to `expired` is in TODO and needed before the staff UI lists online reservations.
- **Money decisions made by default, worth confirming:** invoice numbers per property per year; one live invoice per reservation; payments capped at the reservation total.
- **Paystack facts:** confirmed against Paystack's docs in October 2026: `x-paystack-signature` is HMAC-SHA512 of the raw body keyed with the secret key; the verify endpoint is `GET /transaction/verify/:reference` returning `data.status`, `amount`, `currency`, `channel`; NGN amounts are in kobo; refund events are `refund.pending`, `refund.processing`, `refund.processed`, `refund.failed`. Refund facts confirmed against Paystack's refund docs (October 2026): `POST /refund` takes `transaction` (reference), optional `amount` in subunits, `currency`, `merchant_note`; response `data.status` is pending, processing, processed, failed or needs-attention; refund webhooks carry `data.transaction_reference`, `data.refund_reference` (null while pending), `data.amount` as a STRING, `data.currency`, `data.status`, and there is a `refund.needs-attention` event. The handler matches that (an earlier version expected a numeric amount). Still worth one test-mode refund end to end before go-live; if the shape differs only `lib/webhooks/paystack.ts` changes. Paystack also publishes webhook source IPs; an allowlist is not implemented.
- **Check on staging first:** `is_system_caller()` accepts the `service_role` JWT claim. Supabase's newer secret API keys (`sb_secret_...`) are not JWTs, so confirm on a real project that `create_hold` and `confirm_payment` accept calls made with the key in `SUPABASE_SERVICE_ROLE_KEY`; if not, use the legacy service_role key or adjust the helper.
- **Not built:** screens. Payout is an API route (`POST /api/staff/refunds/<id>/payout`, cookie session, same-origin, JSON out); the staff UI that calls it, the refund queue and the settlement view do not exist yet. The route's session path is unit-tested through `payoutRefund` but not exercised end to end (the e2e uses PostgREST JWTs for staff, not Supabase cookie sessions).
- **Resend facts confirmed against their docs (October 2026):** `POST https://api.resend.com/emails`, bearer key, body `from`, `to`, `subject`, `html`, `text`, response `{ id }`, `Idempotency-Key` header (unique per request, kept 24 hours). `EMAIL_FROM` must be on a domain verified in Resend or sends are refused (the outbox retries, then marks `failed`). Not verified: deliverability, bounces and complaints are not handled (no Resend webhook), so a bounced address is not suppressed.
- **Rate limiting trusts `X-Forwarded-For`:** deploy behind a proxy that sets it (Vercel, Cloudflare, a load balancer). Without one a caller can pick their own address and escape the per-address limits; the per-email and per-reservation limits still apply. Requests with no usable address share one `unknown` bucket.
- **Test-only environment variables:** `PAYSTACK_API_BASE_URL` and `RESEND_API_BASE_URL` exist only so the e2e test can use fake servers; leave them unset in production.
- **Test dates** in `06_holds.sql` are relative to today (offsets 10 to 140, races at 120 and 130); `05_operations.sql` uses up to +72. Keep new tests clear of those ranges.
- **Test helpers** `test_rr`, `test_try_claim`, `test_try_reserve` live in `01_seed.sql` (test-only). `04_reservations.sql`
  depends on users created in `03_security.sql`, so keep the file order.

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
2. Push, confirm CI is green, create a Supabase staging project, apply all sixteen migrations there.
3. Configure the maintenance scheduler and email domain, build the staff UI (refund queue, settlement view, failed-email view, payout button), schedule `expire_lapsed_holds`, build cancellation settlement, and the two
   missing race tests (transfer, block over stay).
4. Continue down `TODO.md` in phase order; do not start online booking before Phase 3 and 4 gates pass.
