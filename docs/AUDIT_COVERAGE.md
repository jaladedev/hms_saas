# Audit coverage review

Reviewed 2026-11-05 against all 48 migrations, by building a scratch database and asking it (triggers, functions that call
`write_audit`, grants and policies), not from memory. Changes made from it: migration 047 and `supabase/tests/49_config_audit.sql`.
Not reviewed: the application code's own logging, and whether a given screen shows a given row (see "Who can read it").

`audit_logs` is insert-only (a trigger refuses update and delete, even for the table owner).

## What is audited, and how

| Area | How | Actions |
| --- | --- | --- |
| Room types, rooms, rate plans, tax rules, policy versions | triggers (`audit_setup_row`, 024, 028, 031) | `<entity>.created / updated / deleted`, with old and new values |
| Nightly prices | statement triggers (024) | `rates.set / changed / cleared` |
| Staff access | functions (016, 019) | `staff.role_added / role_removed / status_changed` |
| Reservations | functions | created, `reservation.checked_in / checked_out / early_checkout_credited (060) / early_checked_in (061) / room.blocked (cancelled count, 068) / stay_changed / discount_changed / guest_links_reset (066) / no_show / settled / hold_created / expired`, `room.transferred / blocked / block_released`, `hold.created` |
| Discount limits | function (059) | `discount_cap.set` (a role's limit at one hotel, with the limit before and after) |
| Money | functions | `invoice.issued / voided`, `payment.recorded / confirmed / reversed / verified` (verified: 056), `payment_attempt.created`, `refund.requested / processing / paid_out / needs_attention / needs_bank_details / bank_details_*` |
| Extras | functions (027) | `folio.charge_posted / charge_voided / payment_recorded / payment_reversed` |
| Extras invoices | functions (048) | `folio_invoice.issued / voided / emailed` |
| Housekeeping, maintenance | functions (018, 023, 026) | `housekeeping.task_*`, `room.housekeeping_set`, `maintenance.*` |
| Guests | `update_guest` (020) | `guest.updated` (names the fields, not their values) |
| Guest emails | `resend_email` | `email.resend_requested` |
| Platform configuration (new, 047) | triggers (`audit_config_row`) | `tenant`, `property`, `tenant_domain`, `payment_provider_account`, `tenant_subscription`, `tenant_feature_entitlement`, `platform_admin`: `.created / updated / deleted` |

## Gaps found and closed (047)

1. **Platform configuration changed with no record.** Which hotel a host reaches (`tenant_domains`), where a hotel's money goes
   (`payment_provider_accounts`), a hotel's plan and features, who is a platform admin, and a hotel's own details were written by the
   service role or from the SQL editor and logged nowhere. Now audited by trigger, so every path is covered. The actor is `auth.uid()`,
   which is null for the service role and the SQL editor (see open item 2).
2. **Guests could be changed without a trace.** Staff with `guest.manage` could `UPDATE guests` directly, skipping `update_guest`
   (migration 020 notes this itself). A guest's email is also what a guest uses to get a booking link back. UPDATE is revoked from
   logins and the policy dropped. INSERT stays: the walk-in booking flow creates guests directly.

## Open (not changed here)

1. **Who can read it.** `audit_logs_select` shows a row only to someone with `audit.view` at the row's property, plus staff access
   changes. So `guest.updated`, `hold.created`, payment and refund rows, and the new platform rows (no property) cannot be read by any
   staff login. The setup history screen lists only setup actions. They exist and are readable by the database owner and the service
   role. Decision for the hotel: is a staff "activity" screen wanted, and for whom?
2. **Service-role and SQL-editor changes have no actor.** The row says what changed and when, not who. A platform admin tool should
   pass the operator into the row; until then, the Supabase dashboard's own logs are the only way to tell who ran a statement.
3. **Direct writes that stay unaudited.** `guests` INSERT (the booking that follows is audited, the new guest row is not on its own);
   `user_profiles` (a person's own display details, INSERT, UPDATE and DELETE by that login).
4. **Deletes by the cleanup job** (`purge_old_operational_data`: rate limit rows, sent emails over 90 days, idempotency keys over 30
   days) are not audited. They are operational data, not records of what staff did.
5. **Retention of `audit_logs` itself.** Nothing purges it and nothing limits its growth. Decide a retention period before launch.
6. **Internal helpers** (`claim_room`, `transfer_claim_internal`, `refresh_money_state`, `refresh_invoice_status`,
   `refresh_reservation_payment_status`, `release_expired_holds`, `enqueue_booking_email`) change derived state and write no audit
   row of their own. Each is called only from a function that audits the business action. A new caller that does not audit would be
   a gap, so any new function that calls them should write its own row.
7. **Monitoring and alerts** (System Design 9.5) are not built; this review does not cover them.
