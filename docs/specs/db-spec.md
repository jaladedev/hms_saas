# Hotel Management System
## PostgreSQL Database and Migration Specification

**Version:** 1.0 — Planning baseline  
**Initial market:** Ibadan, Oyo State, Nigeria  
**Technology:** TypeScript, Next.js, Supabase, PostgreSQL, Supabase Auth, Paystack  
**Product model:** Commercial, multi-tenant SaaS platform  
**Initial deployment:** One hotel, with architecture prepared for multiple hotels and properties

---

# 1. Database design principles

The database must be designed around these requirements:

1. One hotel must never access another hotel's data.
2. A hotel may eventually operate several physical properties.
3. Room-type bookings and specific-room bookings must use the same inventory protection rules.
4. Two concurrent booking requests must not reserve the same room for overlapping dates.
5. Reservation status and payment status must be tracked independently.
6. Payment notifications may arrive more than once or out of order.
7. Financial records must retain their history rather than being silently overwritten.
8. Hotel policies must be configurable without requiring application redeployment.
9. Every important business operation must be auditable.
10. Database migrations must support safe, incremental releases.

## 1.1 Core ownership hierarchy

The ownership structure is:

**Platform → Tenant → Property → Operational records**

- **Platform:** The company operating the HMS product.
- **Tenant:** The hotel business that subscribes to or uses the platform.
- **Property:** An individual hotel location owned or operated by a tenant.
- **Operational records:** Rooms, reservations, invoices, payments, housekeeping tasks, and other hotel data.

A tenant can initially have one property but may add more later.

Every property-owned record must be traceable to its tenant. Where practical, composite foreign keys should enforce that tenant and property references remain consistent.

## 1.2 Important data conventions

| Concern | Standard |
|---|---|
| Primary keys | UUID |
| Database timestamps | `timestamptz`, stored consistently in UTC |
| Hotel operating dates | PostgreSQL `date` |
| Default timezone | `Africa/Lagos` |
| Default currency | `NGN` |
| Monetary amounts | Integer minor units or carefully defined `numeric` values |
| Reservation dates | Arrival inclusive, departure exclusive |
| Deleted financial records | Preserve history; use controlled corrections |
| Database migrations | Version-controlled and reviewed |
| Tenant identification | Derived from verified authorization context |
| Sensitive payment credentials | Encrypted server-side storage |
| Audit timestamps | Database-generated where practical |

For money, use one consistent convention throughout the application. For example, ₦25,000.00 can be represented as `2500000` kobo when the amount is stored in minor units. Provider-specific amount conversion must be explicit and tested.

Do not use floating-point types for monetary values.

---

# 2. Recommended schema groups

The database should be introduced through ordered migrations.

## Migration 001 — Tenant and property foundation

### `tenants`

Represents each hotel business using the platform.

Recommended fields:

- `id`
- `name`
- `slug`
- `status`
- `default_currency`
- `created_at`
- `updated_at`

Recommended tenant statuses:

- `active`
- `suspended`
- `closed`

The slug must be unique where it is used for tenant identification.

Suspending a tenant must not delete its operational or financial history.

### `properties`

Represents each physical hotel.

Recommended fields:

- `id`
- `tenant_id`
- `name`
- `code`
- `address`
- `city`
- `state`
- `country_code`
- `timezone`
- `currency`
- `check_in_time`
- `check_out_time`
- `status`
- `created_at`
- `updated_at`

Initial defaults:

- City: Ibadan
- State: Oyo
- Country: Nigeria
- Country code: `NG`
- Timezone: `Africa/Lagos`
- Currency: `NGN`
- Check-in: `14:00`
- Check-out: `12:00`

These are initial configuration values, not permanent hard-coded rules.

**Constraints:**

- `tenant_id` must reference a valid tenant.
- `(tenant_id, id)` must be unique to support composite foreign keys.
- `(tenant_id, code)` must be unique.
- Property codes should remain stable after creation.
- Timezone values must be validated against supported IANA timezone identifiers.

### `tenant_subscriptions`

Include this table in the first release, but defer automated subscription billing.

Recommended fields:

- `id`
- `tenant_id`
- `plan_code`
- `status`
- `trial_ends_at`
- `current_period_start`
- `current_period_end`
- `created_at`
- `updated_at`

The initial implementation can manage subscription state administratively.

Future billing integration can add provider customer IDs, invoices, payment attempts, and subscription events without coupling SaaS billing to hotel guest payments.

### `tenant_feature_entitlements`

Controls which platform features are available to a tenant.

Recommended fields:

- `id`
- `tenant_id`
- `feature_key`
- `enabled`
- `configuration`
- `created_at`
- `updated_at`

Examples of feature keys:

- `multi_property`
- `online_booking`
- `specific_room_selection`
- `advanced_reporting`
- `additional_payment_providers`

Enforce uniqueness on `(tenant_id, feature_key)`.

Feature entitlements are controlled by the platform, not by ordinary hotel staff.

---

# 3. Migration 002 — Identity, membership and permissions

Use Supabase Auth for authentication. Keep application-specific profile and authorization data in PostgreSQL.

### `user_profiles`

Recommended fields:

- `id` — references the Supabase Auth user ID
- `full_name`
- `phone`
- `avatar_path`
- `created_at`
- `updated_at`

Do not duplicate passwords or authentication secrets in this table.

### `tenant_memberships`

Connects a user to a tenant.

Recommended fields:

- `id`
- `tenant_id`
- `user_id`
- `status`
- `created_at`
- `updated_at`

Enforce uniqueness on `(tenant_id, user_id)`.

Membership statuses:

- `invited`
- `active`
- `suspended`
- `revoked`

### `roles`

Defines roles within the authorization model.

Initial roles:

- Platform administrator
- Hotel owner
- General manager
- Front desk
- Reservations officer
- Accountant
- Housekeeping
- Maintenance

Avoid relying exclusively on a single role field on the user profile. A user may hold different roles at different tenants or properties.

### `permissions`

Defines individual capabilities, such as:

- `reservation.view`
- `reservation.create`
- `reservation.modify`
- `reservation.cancel`
- `room.assign`
- `guest.view`
- `payment.record`
- `payment.refund`
- `invoice.issue`
- `report.view`
- `staff.manage`
- `property.configure`

### `membership_roles`

Assigns roles to tenant memberships, with optional property scope.

### `role_permissions`

Maps roles to permissions.

**Authorization rule:** Every protected business operation must check the user's active membership, role, permission, and applicable property scope.

The user interface can hide unauthorized actions, but the backend and database security policies must independently enforce access.

Platform administrators and hotel staff must be distinct authorization contexts. Any exceptional support access to hotel data must be restricted and audited.

---

# 4. Migration 003 — Room inventory

### `room_types`

Defines bookable categories such as Standard, Deluxe, and Executive.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `name`
- `code`
- `description`
- `max_adults`
- `max_children`
- `max_occupancy`
- `base_rate_minor`
- `currency`
- `status`
- `created_at`
- `updated_at`

Enforce:

- Composite property ownership consistency.
- Unique room-type code per property.
- Non-negative rates.
- Positive occupancy limits.

### `rooms`

Represents physical rooms.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `room_type_id`
- `room_number`
- `floor`
- `operational_status`
- `housekeeping_status`
- `created_at`
- `updated_at`

Use separate status fields for separate business concerns.

**Operational status:**
- `active`
- `out_of_service`
- `retired`

**Housekeeping status:**
- `clean`
- `dirty`
- `in_progress`
- `inspected`

Do not use housekeeping status as a substitute for reservation availability. A clean room can be occupied, while a dirty room can be reserved for a future date.

Enforce:

- Unique room number within a property.
- The room type belongs to the same tenant and property as the room.
- A retired room cannot receive new allocations.
- An out-of-service room cannot receive new allocations for affected dates.

### `room_amenities`

Defines available amenities.

### `room_type_amenities`

Associates amenities with room types.

### `room_images`

Stores image metadata and Supabase Storage paths.

Images should be stored in Storage, not as binary data in ordinary database rows. Access policies must prevent one tenant from modifying another tenant's image objects.

---

# 5. Migration 004 — Rates and hotel policies

### `rate_plans`

Defines pricing plans such as Standard Rate, Flexible Rate, or Advance Purchase.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `name`
- `code`
- `cancellation_policy`
- `payment_policy`
- `currency`
- `status`
- `created_at`
- `updated_at`

### `daily_rates`

Stores room-type prices by date and rate plan.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `room_type_id`
- `rate_plan_id`
- `business_date`
- `amount_minor`
- `currency`
- `created_at`
- `updated_at`

Enforce uniqueness on the relevant combination of property, room type, rate plan, and business date.

The application must define how rates are resolved when no daily rate exists. A sensible initial fallback is the configured room-type base rate, but the rule must be explicit and tested.

### `tax_rules`

Stores configurable tax or levy definitions.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `name`
- `rate_basis`
- `rate_value`
- `effective_from`
- `effective_to`
- `status`

Tax rules require validation against applicable Nigerian and local requirements before production use. Do not assume that a single tax rate or calculation applies to every hotel.

### `property_policies`

Stores configurable operating and booking policies.

Recommended settings include:

- Check-in and check-out times
- Default currency
- Online booking enabled/disabled
- Specific-room selection enabled/disabled
- Reservation confirmation policy
- Payment requirement
- Deposit percentage or amount
- Unpaid hold duration
- Cancellation rules
- No-show rules
- Early check-in and late check-out rules

Store a validated configuration with a version number or effective-date history.

When a reservation is created, preserve the applicable policy snapshot on the reservation. Future policy changes must not silently alter existing bookings.

---

# 6. Migration 005 — Guests and reservations

### `guests`

Recommended fields:

- `id`
- `tenant_id`
- `full_name`
- `email`
- `phone`
- `address`
- `country_code`
- `created_at`
- `updated_at`

Email and phone should not be primary keys. They may change, be shared, or require correction.

Guest search must be tenant-scoped and must avoid unnecessarily exposing personal information.

### `reservations`

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `booking_reference`
- `primary_guest_id`
- `booking_source`
- `reservation_status`
- `payment_status`
- `arrival_date`
- `departure_date`
- `adults`
- `children`
- `currency`
- `subtotal_minor`
- `tax_minor`
- `discount_minor`
- `total_minor`
- `policy_snapshot`
- `created_by`
- `created_at`
- `updated_at`
- `cancelled_at`

Booking sources can include:

- `website`
- `walk_in`
- `phone`
- `staff_entry`
- `partner`

Enforce:

- Departure date is later than arrival date.
- Guest counts are valid.
- Monetary amounts are non-negative where appropriate.
- Booking reference is unique within the intended tenant or property scope.
- The primary guest belongs to the same tenant.
- The property belongs to the same tenant.

Use separate reservation and payment statuses.

**Reservation statuses:**

- `pending`
- `confirmed`
- `checked_in`
- `checked_out`
- `cancelled`
- `no_show`
- `expired`

**Payment statuses:**

- `unpaid`
- `partially_paid`
- `paid`
- `partially_refunded`
- `refunded`
- `payment_failed`

The allowed transitions must be explicitly defined. For example, a checked-out reservation should not be casually reopened through an ordinary edit operation.

### `reservation_guests`

Allows multiple guests to be associated with one reservation.

Recommended fields:

- `id`
- `tenant_id`
- `reservation_id`
- `guest_id`
- `guest_role`
- `created_at`

Use this table when a booking includes additional occupants, while preserving one primary guest for communication and account responsibility.

---

# 7. Migration 006 — Physical-room allocations and booking holds

This is one of the most important parts of the database.

### `room_allocations`

Connects reservations to physical rooms.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `reservation_id`
- `room_id`
- `start_date`
- `end_date`
- `allocation_status`
- `created_at`
- `updated_at`

For a room-type booking, the system should internally select and allocate a physical room. The guest does not necessarily need to see the room number.

For a specific-room booking, the allocation must target the requested room and confirm that it is available.

Enforce:

- `start_date < end_date`.
- The reservation, property, and room belong to the same tenant and property.
- The allocation dates match the applicable reservation dates unless a controlled partial-stay allocation is explicitly supported.
- A room cannot have conflicting active allocations.

A room reassignment must be a controlled transaction. The application must verify the replacement room's availability before releasing the original allocation.

### Preventing double bookings

A normal application-level check such as “query available rooms, then insert a reservation” is not sufficient. Two concurrent requests can both see the same room as available.

Use database-enforced concurrency protection.

A recommended PostgreSQL approach is:

1. Enable the `btree_gist` extension if supported by the deployment.
2. Represent allocation periods using half-open date ranges: `[start_date, end_date)`.
3. Use a PostgreSQL exclusion constraint to reject overlapping active allocations for the same room.
4. Ensure only allocation statuses that genuinely reserve inventory participate in that constraint.
5. Perform availability checks, allocation, and reservation changes inside a transaction.
6. Retry eligible transactions when a serialization or concurrency conflict occurs.

Illustrative constraint concept:

`room_id WITH =` combined with `daterange(start_date, end_date, '[)') WITH &&`

The production migration must use the exact supported PostgreSQL syntax, status predicates, and tenant/property constraints verified against the final schema.

The half-open date range means that a guest departing on October 20 does not conflict with another guest arriving on October 20.

**Important:** An exclusion constraint prevents overlapping allocations, but it does not replace checks for room maintenance blocks, expired holds, tenant ownership, or valid reservation state.

### `booking_holds`

Temporary inventory reservations for unfinished online bookings.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `room_id`
- `room_type_id`
- `session_reference`
- `expires_at`
- `hold_status`
- `created_at`
- `released_at`

A hold may target a physical room or a room type, depending on the booking flow. For specific-room bookings, it must protect the requested room. For room-type bookings, the system must ensure that the held inventory is backed by a real available room rather than relying only on a count that can become stale.

The preferred approach is to allocate a specific physical room to the hold or to use a database-backed inventory reservation mechanism that provides equivalent concurrency guarantees.

Hold statuses can include:

- `active`
- `converted`
- `released`
- `expired`

Expired holds must be treated as inactive based on `expires_at`, even if a scheduled cleanup process has not yet updated their status.

Use a scheduled job to clean up expired holds, but never depend on the job as the sole availability safeguard.

---

# 8. Migration 007 — Room blocks, maintenance and housekeeping

### `room_blocks`

Records periods when a room cannot be sold.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `room_id`
- `start_date`
- `end_date`
- `block_type`
- `reason`
- `status`
- `created_by`
- `created_at`

Examples include maintenance, renovations, owner use, and operational closure.

Availability checks must consider room blocks as well as allocations and holds.

Where possible, apply database-level overlap protection to conflicting blocks and active allocations. Because blocks and allocations are separate tables, their interaction requires a transaction or a shared inventory-locking strategy; separate exclusion constraints alone cannot prevent a block from overlapping an allocation in another table.

### `maintenance_requests`

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `room_id`
- `title`
- `description`
- `priority`
- `status`
- `reported_by`
- `assigned_to`
- `created_at`
- `resolved_at`

### `housekeeping_tasks`

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `room_id`
- `task_type`
- `status`
- `priority`
- `assigned_to`
- `due_at`
- `completed_at`
- `created_at`

Housekeeping completion must not automatically mark a room as vacant or available. Reservation occupancy and room cleanliness are separate concerns.

---

# 9. Migration 008 — Invoices and financial records

### `invoices`

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `reservation_id`
- `invoice_number`
- `invoice_status`
- `currency`
- `subtotal_minor`
- `tax_minor`
- `discount_minor`
- `total_minor`
- `issued_at`
- `due_at`
- `created_at`

Invoice statuses may include:

- `draft`
- `issued`
- `partially_paid`
- `paid`
- `void`

Once issued, an invoice should not be silently rewritten. Corrections should use an approved void, credit note, or adjustment process appropriate to the accounting design.

A reservation and an invoice must remain separate records. This permits multiple invoices or financial documents for one reservation when needed.

### `invoice_lines`

Recommended fields:

- `id`
- `tenant_id`
- `invoice_id`
- `description`
- `quantity`
- `unit_amount_minor`
- `tax_amount_minor`
- `line_total_minor`
- `service_date`

Preserve the description and monetary values used at the time the line is created. Do not dynamically derive historical invoice totals from current room rates.

### `payments`

Represents money received or a payment attempt, depending on the final payment model.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `reservation_id`
- `payment_provider`
- `payment_method`
- `provider_reference`
- `internal_reference`
- `amount_minor`
- `currency`
- `payment_status`
- `received_at`
- `created_at`
- `updated_at`

The final implementation should distinguish payment attempts from successfully received funds if multiple attempts can be made against one booking. A dedicated `payment_attempts` table is recommended if the payment workflow needs that level of detail.

Do not treat a browser redirect to a success page as proof that payment succeeded.

### `payment_allocations`

Associates payments with invoices.

Recommended fields:

- `id`
- `tenant_id`
- `payment_id`
- `invoice_id`
- `amount_minor`
- `created_at`

This allows one payment to be applied to an invoice, or to multiple invoices where the business rules permit it.

Enforce that allocations do not exceed the amount available for allocation, using transactional checks and database safeguards where practical.

### `refunds`

Recommended fields:

- `id`
- `tenant_id`
- `payment_id`
- `provider_reference`
- `amount_minor`
- `currency`
- `refund_status`
- `reason`
- `created_by`
- `created_at`
- `updated_at`

Refunds must be authorized and reconciled. A refund request is not the same as a completed refund.

### `payment_events`

Stores provider webhook events and processing results.

Recommended fields:

- `id`
- `tenant_id`
- `provider`
- `provider_event_id`
- `event_type`
- `provider_reference`
- `processing_status`
- `received_at`
- `processed_at`
- `error_summary`

Where the provider supplies a stable event identifier, enforce uniqueness on the appropriate provider-and-event combination.

Verify webhook authenticity using Paystack's documented verification procedure. Use idempotent processing so repeated webhook delivery cannot record the same payment twice.

Never trust an amount, currency, tenant ID, or payment status supplied by the browser. Reconcile the provider's verified transaction details against the internal payment record before confirming a booking as paid.

### `payment_provider_accounts`

Stores each tenant's payment-provider configuration.

Recommended fields:

- `id`
- `tenant_id`
- `provider`
- `account_label`
- `public_configuration`
- `secret_reference`
- `status`
- `created_at`
- `updated_at`

`secret_reference` should point to securely stored server-side credentials, not contain an exposed secret.

Provider credentials must not be readable by ordinary hotel users or exposed through public APIs. The platform should support separate test and live configurations and must validate the merchant's actual Paystack account configuration before production activation.

---

# 10. Migration 009 — Audit, idempotency and background jobs

### `audit_logs`

Records significant actions.

Recommended fields:

- `id`
- `tenant_id`
- `property_id`
- `actor_user_id`
- `action`
- `entity_type`
- `entity_id`
- `request_id`
- `metadata`
- `created_at`

Examples:

- Reservation created or cancelled
- Room reassigned
- Payment recorded manually
- Refund requested or approved
- Invoice issued or voided
- Staff permissions changed
- Payment-provider settings changed
- Guest data accessed through exceptional support workflows

Avoid placing passwords, access tokens, card data, or unnecessary sensitive personal information in audit metadata.

Application roles should not be able to arbitrarily rewrite or delete audit history. Restrict access and define retention requirements.

### `idempotency_keys`

Protects important operations against accidental repetition.

Recommended fields:

- `id`
- `tenant_id`
- `idempotency_key`
- `operation`
- `request_hash`
- `response_reference`
- `status`
- `created_at`
- `expires_at`

Enforce uniqueness on the appropriate tenant-and-operation key.

Use idempotency for operations such as:

- Creating reservations
- Initiating payment attempts
- Recording verified payments
- Processing refunds
- Issuing invoices

A reused key with a different request payload should be rejected rather than treated as an identical retry.

### `outbox_events`

Provides a reliable mechanism for scheduling external side effects after database transactions.

Recommended fields:

- `id`
- `tenant_id`
- `event_type`
- `aggregate_type`
- `aggregate_id`
- `payload`
- `status`
- `attempt_count`
- `available_at`
- `processed_at`
- `created_at`

Use it for actions such as booking confirmation emails, housekeeping notifications, and reporting updates.

The business transaction should commit first. A background worker then processes the event, with retry limits, error logging, and idempotent delivery.

---

# 11. Row-Level Security and tenant isolation

Row-Level Security (RLS) must be enabled on tables accessible through Supabase client-facing APIs.

However, RLS alone is not a complete authorization system. Use it together with server-side permission checks and carefully controlled database functions.

## 11.1 Recommended security model

1. Authenticate users through Supabase Auth.
2. Resolve the user's active tenant membership on the server.
3. Verify the requested property belongs to that tenant.
4. Check the user's role and permission for the requested operation.
5. Apply the same ownership checks in database constraints and protected functions where appropriate.
6. Keep privileged service credentials exclusively on trusted server-side infrastructure.

Never accept a browser-supplied `tenant_id` as proof of access.

## 11.2 RLS policy design

For each tenant-owned table, define policies for the operations actually needed:

- `SELECT`: users may read records for authorized tenants and properties.
- `INSERT`: users may create records only within their authorized scope and permitted operations.
- `UPDATE`: users may change only records they are authorized to modify.
- `DELETE`: deny by default for important business records; use explicit controlled operations when deletion is justified.

Do not automatically give all tenant members full access to every table. For example, housekeeping staff may need room task information without needing access to guest financial records.

Where client-side direct database access is enabled, ensure the RLS policy independently enforces the required row scope. For sensitive financial or inventory operations, prefer narrowly defined server-side functions or service endpoints that execute validated transactional workflows.

## 11.3 Security test requirements

Tests must demonstrate that:

- Tenant A cannot read Tenant B's reservations.
- Tenant A cannot update Tenant B's room rates.
- A front-desk user cannot issue unauthorized refunds.
- A housekeeping user cannot read unrelated financial records.
- A user cannot change their own role to become an administrator.
- A revoked membership loses access.
- An unauthorized user cannot access tenant data through a guessed UUID.
- Public booking requests expose only the minimum necessary data.
- Storage policies prevent cross-tenant access to private files.

These tests are release blockers, not optional hardening.

---

# 12. Required transactional operations

The following operations must be designed as explicit database transaction boundaries or equivalent atomic server-side workflows.

## 12.1 Create a reservation

Within one transaction:

1. Validate the guest, property, dates, guest counts, and policy.
2. Resolve the applicable room type and pricing.
3. Lock or otherwise serialize access to the relevant inventory.
4. Recheck active allocations, holds, room blocks, and room operational status.
5. Select a valid physical room, if inventory is available.
6. Create the reservation and its allocation or inventory hold.
7. Snapshot the applicable rate and policy details.
8. Create the required invoice or payment obligation.
9. Write an audit event and any outbox events.
10. Commit the transaction.

If any required step fails, roll back the transaction.

For online bookings, the reservation confirmation and payment requirements must follow the hotel's configured policy. A pending reservation must not become confirmed merely because the initial browser request succeeded.

## 12.2 Confirm a payment

1. Receive the provider event or verification request.
2. Verify the event's authenticity or query the provider using a trusted server-side request.
3. Match the provider reference to the expected internal payment.
4. Validate the amount, currency, provider account, and transaction status.
5. Check whether the event or transaction has already been processed.
6. Record the verified payment and allocate funds to the relevant invoice.
7. Update payment and reservation statuses according to the configured policy.
8. Convert or release any relevant inventory hold atomically.
9. Record the audit event and enqueue required notifications.
10. Commit the transaction.

If the payment succeeds but the booking can no longer be honored, the system must follow an explicit recovery process rather than silently losing the payment or creating an invalid allocation.

## 12.3 Cancel a reservation

1. Verify permission and current reservation state.
2. Calculate applicable cancellation charges under the saved policy.
3. Release inventory only when the cancellation transaction is valid.
4. Update reservation and invoice-related records according to accounting rules.
5. Initiate any required refund as a separate tracked operation.
6. Record the audit event and enqueue notifications.
7. Commit the transaction.

Do not assume cancellation means the payment has been refunded.

## 12.4 Check in a guest

1. Verify the reservation and its current state.
2. Confirm arrival-date and operational requirements, or validate an authorized early check-in.
3. Confirm that the assigned room is not blocked or otherwise unavailable.
4. Confirm the payment requirements specified by the booking policy.
5. Update the reservation state.
6. Update operational records and create housekeeping tasks where appropriate.
7. Record the audit event.

## 12.5 Check out a guest

1. Verify that the reservation is checked in.
2. Calculate outstanding charges under the hotel's rules.
3. Record any final invoice lines.
4. Validate settlement or the authorized outstanding-balance arrangement.
5. Mark the reservation checked out.
6. Create a housekeeping task.
7. Record the audit event.

The room's housekeeping state must not be changed to clean until the required housekeeping workflow is completed.

---

# 13. Indexes and data integrity

Create indexes based on actual access patterns and verify them with query plans.

Recommended starting indexes include:

- Tenant membership by `(tenant_id, user_id)`.
- Properties by `(tenant_id, status)`.
- Rooms by `(property_id, room_type_id, operational_status)`.
- Reservations by `(property_id, arrival_date, departure_date)`.
- Reservations by `(tenant_id, booking_reference)`.
- Reservations by `(property_id, reservation_status, arrival_date)`.
- Allocations by `(room_id, start_date, end_date)`.
- Active holds by `(property_id, expires_at)`.
- Invoices by `(property_id, invoice_status, due_at)`.
- Payments by `(reservation_id, payment_status)`.
- Payment events by provider event identity.
- Housekeeping tasks by `(property_id, status, due_at)`.
- Maintenance requests by `(property_id, status, priority)`.
- Audit logs by `(tenant_id, created_at)`.

For foreign keys and composite ownership relationships, create appropriate supporting indexes where PostgreSQL does not already have an index that serves the query.

Use partial indexes for active allocations or unprocessed events when they materially improve the relevant queries.

Do not create every conceivable index preemptively. Excessive indexes slow writes and increase storage requirements.

---

# 14. Migration and release order

Use the following sequence:

1. Tenant and property tables.
2. Identity, memberships, roles, and permissions.
3. Room inventory and amenities.
4. Pricing and hotel policies.
5. Guests and reservations.
6. Room allocations and booking holds.
7. Maintenance and housekeeping.
8. Invoices, payments, refunds, and provider accounts.
9. Audit logs, idempotency, and outbox events.
10. RLS policies and database functions.
11. Performance indexes and operational reporting.
12. Seed data, migration verification, and release checks.

RLS and authorization must be implemented alongside the tables they protect; this sequence is a planning order, not permission to deploy intermediate releases with exposed tables.

Each migration must be version-controlled, repeatable where appropriate, and tested against a staging database representative of production.

Use backward-compatible schema changes where possible. For example, add a nullable field, deploy code that supports it, backfill the data, and only then make it mandatory when safe.

Never rely on a manual production database edit as the only record of a schema change.

---

# 15. Testing and acceptance criteria

The database and core transaction workflows are ready for MVP acceptance only when all of the following pass.

## Inventory and reservations

- A room cannot be booked twice for overlapping dates.
- Two simultaneous requests for the last available room cannot both succeed.
- A room-type booking receives valid physical inventory.
- A specific-room booking honors the requested room or returns a clear unavailable response.
- A departure date can match the next guest's arrival date.
- Active maintenance blocks prevent incompatible allocations.
- Expired holds do not permanently consume inventory.
- Staff room reassignment checks availability atomically.
- Cancellation releases inventory only after the cancellation workflow succeeds.

## Payments and finance

- A payment cannot be confirmed solely from browser input.
- Duplicate webhooks do not duplicate payment records or invoice allocations.
- Incorrect provider amounts or currencies are rejected for reconciliation.
- Failed payments do not incorrectly mark reservations as paid.
- Partial payments produce correct outstanding balances.
- Refund requests and completed refunds remain distinguishable.
- Issued invoice history remains auditable.
- A payment associated with one hotel's provider account cannot be applied to another hotel's reservation.

## Authorization and data protection

- Cross-tenant access tests pass.
- Role restrictions are enforced on server-side operations.
- Revoked users cannot continue accessing protected data.
- Privileged credentials never reach the browser.
- Guest and payment information is not unnecessarily exposed in logs.
- Private files are protected by appropriate Storage policies.

## Reliability and operations

- Failed transactions leave no partial reservation or allocation.
- Idempotent operations return safe results on retries.
- Background events retry without duplicating business effects.
- Backup restoration is tested before launch.
- Production migrations are rehearsed in staging.
- Monitoring detects payment failures, booking conflicts, and failed background jobs.

---

# 16. Outstanding implementation decisions

These decisions should be finalized before the corresponding module is implemented:

1. **Exact reservation and payment state transitions:** Define permitted transitions and authorized roles.
2. **Room-type inventory allocation:** Choose the precise concurrency-control implementation and test it under simultaneous booking load.
3. **Payment attempts:** Decide whether to use a separate `payment_attempts` table from the first release. The recommended design is yes.
4. **Invoice numbering:** Define whether numbers are sequential per property, per tenant, or follow another accounting requirement.
5. **Taxes and levies:** Validate the applicable calculations with qualified Nigerian accounting or tax advice.
6. **Data retention and privacy:** Define retention, deletion, access, and incident-response policies against applicable Nigerian privacy requirements.
7. **Payment provider setup:** Confirm Paystack merchant eligibility, enabled payment channels, webhook configuration, settlement, and refund behavior.
8. **Backup and recovery:** Confirm achievable recovery-point and recovery-time objectives with the chosen Supabase plan and operational setup.

## Final recommendation

Treat this schema as the reviewed design baseline, not as an already executed migration. Before implementation, translate it into concrete PostgreSQL migrations and test the actual constraints, transaction behavior, RLS policies, and Paystack integration against the chosen Supabase environment.

The most important technical safeguard is that **availability, inventory allocation, reservation state, and payment confirmation must be enforced by trusted transactional operations—not by frontend logic alone.**