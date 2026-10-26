# Hotel Management System
## Complete UI Page Specification

**Product:** Commercial Hotel Management System  
**Initial hotel:** Ibadan, Oyo State, Nigeria  
**Platform:** Responsive web application  
**Technology direction:** Next.js, TypeScript, Tailwind CSS, Supabase  
**Design approach:** Desktop-first for hotel operations, mobile-friendly for staff, mobile-first for guests.

---

# 1. Overall application structure

The platform will have three distinct interfaces.

| Interface | Primary users | Suggested route prefix |
|---|---|---|
| Hotel Management Dashboard | Hotel owners and staff | `/app` |
| Guest Booking Website | Guests and prospective customers | Public website routes |
| Platform Administration | Your SaaS business team | `/platform` |

All three interfaces should share a design system but have separate navigation, permissions, and workflows.

## 1.1 Hotel dashboard layout

The main dashboard should use a persistent sidebar, a top navigation bar, and a responsive content area.

**Sidebar navigation:**

- Overview
- Front Desk
- Reservations
- Room Management
- Guests
- Housekeeping
- Maintenance
- Payments & Billing
- Reports
- Staff & Permissions
- Settings

**Top navigation:**

- Property selector, if the user has access to multiple properties
- Global search
- Notifications
- Quick-create button
- Help
- User profile and sign out

For the first hotel, the property selector can remain simple or be hidden until needed. The underlying architecture should still support multiple properties.

---

# 2. Hotel Management Dashboard pages

## A. Authentication and onboarding

### Page 1 — Sign In
**Route:** `/login`

Elements:
- Hotel brand logo
- Email field
- Password field
- Show/hide password
- Remember-session option where appropriate
- Sign-in button
- Forgot-password link
- Error and loading states

Requirements:
- Use Supabase Auth.
- Redirect users to the correct dashboard after successful authentication.
- Enforce tenant membership and permissions on the server.
- Never reveal whether an arbitrary email address belongs to an account through overly specific error messages.

### Page 2 — Forgot Password
**Route:** `/forgot-password`

Elements:
- Email field
- Send recovery link
- Confirmation message
- Return-to-login link

### Page 3 — Reset Password
**Route:** `/reset-password`

Elements:
- New password
- Confirm password
- Password validation
- Success and expired-link states

### Page 4 — Initial Hotel Setup
**Route:** `/app/setup`

A guided onboarding wizard for the hotel owner.

Steps:
1. Hotel details
2. Address and contact information
3. Check-in and check-out times
4. Room types
5. Physical rooms
6. Rates and policies
7. Payment configuration
8. Booking website configuration
9. Review and activate

The wizard should save progress so users can continue later.

### Page 5 — Invite Staff
**Route:** `/app/staff/invite`

Elements:
- Staff name
- Email or supported invitation identifier
- Role selection
- Property access
- Permission summary
- Send invitation

Only authorized users may invite staff or grant roles.

---

## B. Dashboard and front desk

### Page 6 — Main Dashboard
**Route:** `/app`

This is the primary landing page for hotel management.

**Summary cards:**
- Occupied rooms
- Available rooms
- Arrivals today
- Departures today
- Expected occupancy
- Outstanding balances
- Revenue today

**Main sections:**
- Today's arrivals and departures
- Current in-house guests
- Recent reservations
- Room-status overview
- Pending payments
- Housekeeping alerts
- Maintenance alerts

**Quick actions:**
- New reservation
- Walk-in check-in
- Check out guest
- Assign room
- Record payment
- Create maintenance request

Dashboard figures must be derived from consistent business definitions. For example, room occupancy should not count rooms that are retired or unavailable for sale as ordinary sellable inventory.

### Page 7 — Front Desk Operations
**Route:** `/app/front-desk`

A workspace for staff managing guests arriving, staying, or departing.

Tabs:
- Arrivals
- In-house
- Departures
- Walk-ins
- Pending actions

Each row should show:
- Guest name
- Booking reference
- Room or room type
- Arrival/departure date
- Reservation status
- Payment status
- Special notes, subject to permission

Actions:
- View reservation
- Check in
- Check out
- Assign or change room
- Record payment
- Print or issue guest documents

### Page 8 — Room Board
**Route:** `/app/room-board`

A visual view of physical-room status.

Suggested layout:
- Room cards grouped by floor
- Filter by room type
- Filter by operational status
- Filter by housekeeping status
- Search room number

Each room card can show:
- Room number
- Room type
- Occupancy state
- Housekeeping state
- Current or upcoming reservation
- Maintenance indicator

Use distinct labels and icons in addition to colors, so status is not communicated through color alone.

Clicking a room opens a detail panel with room history, active allocation, housekeeping tasks, and permitted actions.

### Page 9 — Walk-In Booking
**Route:** `/app/front-desk/walk-in`

A streamlined booking form for guests who arrive without a reservation.

Steps:
1. Search for an existing guest or create a new guest profile.
2. Enter arrival and departure dates.
3. Enter guest count.
4. Check room availability.
5. Select a room type or physical room.
6. Confirm rate and payment policy.
7. Create the reservation.
8. Record any payment.
9. Check in if appropriate.

The system must run the same inventory and payment checks as online reservations.

---

## C. Reservations

### Page 10 — Reservation List
**Route:** `/app/reservations`

Features:
- Search by booking reference or guest
- Filter by arrival and departure dates
- Filter by status
- Filter by payment status
- Filter by booking source
- Sort by date or creation time
- Pagination
- Export only where authorized

Table columns:
- Booking reference
- Guest
- Arrival
- Departure
- Room or room type
- Total amount
- Amount paid
- Reservation status
- Payment status
- Actions

### Page 11 — Create Reservation
**Route:** `/app/reservations/new`

A multi-step booking form.

**Step 1: Stay**
- Arrival date
- Departure date
- Adults
- Children

**Step 2: Inventory**
- Available room types
- Rate plans
- Physical-room selection, where applicable
- Room availability and restrictions

**Step 3: Guest**
- Search existing guest
- Create guest
- Contact details
- Additional occupants

**Step 4: Price and policy**
- Nightly rates
- Number of nights
- Discounts, where authorized
- Taxes and applicable charges
- Deposit or payment requirement
- Cancellation policy

**Step 5: Confirm**
- Review booking details
- Create reservation
- Issue invoice or payment request as appropriate

### Page 12 — Reservation Details
**Route:** `/app/reservations/[id]`

This should be one of the most complete pages in the application.

**Header:**
- Booking reference
- Guest name
- Reservation status
- Payment status
- Primary actions

**Sections or tabs:**
1. Overview
2. Guests
3. Room allocation
4. Pricing and invoice
5. Payments and refunds
6. Activity history
7. Internal notes

Actions depend on permissions and state:
- Edit permitted details
- Assign room
- Reassign room
- Confirm reservation
- Cancel reservation
- Check in
- Check out
- Record payment
- Request refund
- Print invoice or confirmation

Financial actions should require explicit confirmation and preserve audit history.

### Page 13 — Calendar View
**Route:** `/app/reservations/calendar`

Display reservations across dates.

Useful features:
- Day, week, and month views
- Filter by room type or floor
- Show physical-room allocations
- Show tentative reservations or holds distinctly
- Highlight maintenance blocks
- Navigate between dates

Moving a reservation to a different room or date must invoke server-side availability validation. Drag-and-drop must never bypass booking constraints.

### Page 14 — Reservation Confirmation and Documents
**Route:** `/app/reservations/[id]/documents`

Generate or display:
- Booking confirmation
- Guest registration document, if used
- Invoice
- Receipt
- Cancellation confirmation

Document content should reflect saved transaction values rather than current rates or policies.

---

## D. Room and inventory management

### Page 15 — Room Types
**Route:** `/app/room-types`

Features:
- Room-type list
- Name and code
- Occupancy capacity
- Base rate
- Active/inactive status
- Number of physical rooms

Actions:
- Create room type
- Edit details
- Configure amenities
- Manage images
- View associated rooms

### Page 16 — Room Type Editor
**Route:** `/app/room-types/[id]`

Fields:
- Name
- Internal code
- Description
- Maximum adults and children
- Maximum occupancy
- Base rate
- Currency
- Amenities
- Images
- Public booking visibility

Prevent users from deleting a room type that has historical reservations. Deactivation is usually preferable.

### Page 17 — Physical Rooms
**Route:** `/app/rooms`

Features:
- Room number
- Room type
- Floor
- Operational status
- Housekeeping status
- Current allocation
- Maintenance indicator

Actions:
- Add room
- Edit room details
- Change operational status
- Open room history
- Create room block
- Create maintenance request

### Page 18 — Room Details
**Route:** `/app/rooms/[id]`

Sections:
- Room information
- Upcoming reservations
- Current occupancy
- Housekeeping history
- Maintenance history
- Room blocks
- Audit history

### Page 19 — Availability Management
**Route:** `/app/availability`

Features:
- Search dates
- Room-type availability
- Physical-room availability
- Maintenance and room-block visibility
- Availability summary
- Link to create a reservation

Availability shown here is informational until the server validates and commits an allocation.

### Page 20 — Room Blocks
**Route:** `/app/room-blocks`

Features:
- List scheduled blocks
- Filter by room and date
- Create maintenance or operational block
- Edit or cancel a permitted block
- Detect conflicts with existing allocations

A block must not be created over a confirmed stay without a deliberate, authorized resolution workflow.

---

## E. Guest management

### Page 21 — Guest Directory
**Route:** `/app/guests`

Features:
- Search guest name
- Search phone or email with appropriate access controls
- View reservation count
- View last stay
- Filter by recent activity

### Page 22 — Guest Profile
**Route:** `/app/guests/[id]`

Sections:
- Contact information
- Guest preferences, where appropriate
- Reservation history
- Outstanding balances, subject to permission
- Internal notes, subject to permission

Do not expose payment credentials or unnecessary sensitive information.

### Page 23 — Create or Edit Guest
**Route:** `/app/guests/new` and `/app/guests/[id]/edit`

Fields:
- Full name
- Phone
- Email
- Address, where required
- Country
- Optional notes

Avoid using phone number or email as a unique database identifier.

---

## F. Housekeeping and maintenance

### Page 24 — Housekeeping Dashboard
**Route:** `/app/housekeeping`

Summary:
- Dirty rooms
- Rooms being cleaned
- Rooms awaiting inspection
- Completed tasks

Views:
- Task list
- Room board
- My assigned tasks

Actions:
- Start cleaning
- Mark cleaning complete
- Submit for inspection
- Mark inspected

### Page 25 — Housekeeping Task Details
**Route:** `/app/housekeeping/[id]`

Show:
- Room number
- Task type
- Priority
- Assigned staff
- Due time
- Status history
- Notes

### Page 26 — Maintenance Dashboard
**Route:** `/app/maintenance`

Features:
- Open requests
- High-priority issues
- Assigned tasks
- Overdue requests
- Resolved requests

### Page 27 — Maintenance Request Details
**Route:** `/app/maintenance/[id]`

Fields and actions:
- Issue description
- Room
- Priority
- Assigned technician
- Status
- Notes
- Resolution details
- Related room block

Closing a maintenance task should not automatically make a room available if another operational restriction remains.

---

## G. Payments and billing

### Page 28 — Payments Overview
**Route:** `/app/payments`

Summary:
- Payments received today
- Pending payments
- Failed payments
- Refunds pending
- Unreconciled transactions

Filters:
- Date
- Provider
- Payment method
- Status
- Booking reference

### Page 29 — Payment Details
**Route:** `/app/payments/[id]`

Show:
- Internal payment reference
- Reservation
- Invoice allocations
- Amount and currency
- Payment method
- Provider reference
- Verification status
- Event history
- Refund history

Do not show provider secrets or sensitive payment credentials.

### Page 30 — Record Manual Payment
**Route:** `/app/payments/record`

Supported methods:
- Cash
- Bank transfer
- Card terminal or other approved card payment
- Other configured hotel methods

Fields:
- Reservation or invoice
- Amount
- Method
- Reference
- Received date
- Notes

Manual payment entry should be permission-controlled and audited. Bank transfer evidence alone should not automatically mark a payment as verified.

### Page 31 — Invoices
**Route:** `/app/invoices`

Features:
- Invoice list
- Invoice number
- Guest
- Booking reference
- Total
- Amount paid
- Outstanding balance
- Due date
- Status

### Page 32 — Invoice Details
**Route:** `/app/invoices/[id]`

Show:
- Issued invoice
- Line items
- Tax and charges
- Payments applied
- Balance due
- Printable or downloadable document

### Page 33 — Refund Management
**Route:** `/app/refunds`

Features:
- Refund requests
- Refund status
- Original payment
- Amount
- Reason
- Approval and processing actions

Refund requests must follow the configured authorization process and provider rules.

### Page 34 — Payment Reconciliation
**Route:** `/app/payments/reconciliation`

Compare:
- Internal payment records
- Verified provider transactions
- Provider references
- Amounts
- Currency
- Settlement or refund status, where available

Highlight mismatches and unresolved transactions for authorized staff.

---

## H. Rates, policies, and booking settings

### Page 35 — Rate Plans
**Route:** `/app/rates`

Manage:
- Rate plans
- Default prices
- Room-type pricing
- Rate plan status
- Cancellation and payment terms

### Page 36 — Rate Calendar
**Route:** `/app/rates/calendar`

A date-based grid for editing room rates.

Features:
- Room types as rows
- Dates as columns
- Daily prices
- Bulk date updates
- Rate overrides
- Validation for invalid amounts

### Page 37 — Booking Policies
**Route:** `/app/settings/booking`

Settings:
- Check-in time
- Check-out time
- Confirmation policy
- Deposit requirement
- Full-payment requirement
- Pay-at-hotel availability
- Unpaid hold duration
- Cancellation policy
- No-show policy
- Specific-room selection

Changes should be versioned or snapshotted so existing bookings retain their original terms.

### Page 38 — Payment Provider Settings
**Route:** `/app/settings/payments`

Initial provider: Paystack.

Elements:
- Connection status
- Test/live mode
- Credential configuration
- Enabled payment channels
- Webhook health
- Last successful verification
- Test transaction workflow, where supported

The interface must not display secret keys after they have been saved. Credentials should be stored using an appropriate secure server-side mechanism.

### Page 39 — Property Settings
**Route:** `/app/settings/property`

Settings:
- Hotel name
- Address
- Contact information
- Timezone
- Currency
- Operating hours
- Public booking contact details
- Logo and branding

Changes to currency or timezone must be handled carefully when historical financial and booking records already exist.

---

## I. Reports and staff administration

### Page 40 — Reports Overview
**Route:** `/app/reports`

Initial reports:
- Occupancy
- Arrivals and departures
- Revenue by day
- Revenue by room type
- Reservation sources
- Outstanding balances
- Cancellation and no-show rates
- Housekeeping activity
- Maintenance activity

Each report should explain its date range and calculation method.

### Page 41 — Report Details
**Route:** `/app/reports/[report]`

Common features:
- Date-range selection
- Property filter
- Summary metrics
- Table or chart
- Export where authorized

Financial reports must reconcile with the underlying invoice and payment records.

### Page 42 — Staff Directory
**Route:** `/app/staff`

Features:
- Staff members
- Roles
- Property access
- Invitation status
- Account status

### Page 43 — Staff Details and Permissions
**Route:** `/app/staff/[id]`

Features:
- Assigned roles
- Permission summary
- Property scope
- Recent activity
- Suspend or revoke access

Prevent users from granting permissions they themselves are not authorized to administer.

### Page 44 — Audit Log
**Route:** `/app/audit-log`

Search and filter:
- Actor
- Action
- Record type
- Date range
- Request reference

Access must be restricted to authorized roles. Audit records should not be editable through the ordinary dashboard.

### Page 45 — Notification Center
**Route:** `/app/notifications`

Show:
- Payment alerts
- Booking updates
- Failed background jobs where relevant to staff
- Housekeeping alerts
- Maintenance alerts
- Important system notices

Only show notifications the current user is permitted to access.

---

# 3. Guest Booking Website pages

The guest-facing website should prioritize trust, speed, clear pricing, and a short booking process.

## Page 46 — Homepage
**Route:** `/`

Sections:
- Hotel branding and hero image
- Booking search form
- Room highlights
- Amenities
- Location and directions
- Guest information
- Contact details
- Booking policies
- Footer with privacy and terms links

The booking form should collect:
- Arrival date
- Departure date
- Adults
- Children
- Room count, if supported

## Page 47 — Room Search Results
**Route:** `/rooms`

Show:
- Available room types
- Images
- Descriptions
- Occupancy capacity
- Rate for the selected stay
- Included amenities
- Cancellation terms
- Availability status

Do not display unavailable rooms as bookable options.

## Page 48 — Room Details
**Route:** `/rooms/[slug]`

Show:
- Room gallery
- Description
- Bed configuration
- Occupancy limits
- Amenities
- Price summary
- Stay dates
- Booking action

If specific-room selection is enabled, show only eligible rooms that are available for the entire requested stay. Avoid exposing operational information that is not appropriate for public users.

## Page 49 — Guest Details and Booking
**Route:** `/book/guest-details`

Fields:
- Guest full name
- Email
- Phone
- Guest count
- Special requests
- Acceptance of applicable booking terms

Show a clear booking summary before payment.

## Page 50 — Room Selection
**Route:** `/book/room-selection`

Optional page, shown when the hotel permits specific physical-room selection.

Show:
- Eligible room numbers or approved room labels
- Room features relevant to guest choice
- Selection confirmation

Room selection must be validated and held safely by the server. A displayed room is not guaranteed until the booking workflow has secured the inventory.

## Page 51 — Review and Payment
**Route:** `/book/review`

Show:
- Hotel and room details
- Stay dates
- Guest information
- Nightly rate breakdown
- Taxes and charges
- Deposit or full amount due
- Cancellation policy
- Payment method options

Supported initial payment methods should reflect the actual hotel configuration and Paystack account capabilities.

## Page 52 — Payment Processing
**Route:** `/book/payment`

This page should:
- Display payment instructions
- Redirect to or launch the provider's approved payment experience
- Show a safe pending state when confirmation is delayed
- Prevent repeated submissions

The browser must never determine that payment succeeded.

## Page 53 — Booking Confirmation
**Route:** `/booking/confirmation`

Show:
- Booking reference
- Reservation status
- Payment status
- Guest name
- Stay dates
- Room or room type
- Amount paid and balance due
- Check-in and checkout times
- Contact details

Only show a confirmed state after the backend has verified the reservation's actual status. If payment or reservation confirmation is still pending, explain that clearly.

## Page 54 — Booking Lookup
**Route:** `/booking/lookup`

Allow guests to retrieve their reservation through a secure verification process.

Do not expose booking information based solely on a predictable booking reference.

## Page 55 — Manage Booking
**Route:** `/booking/manage`

Depending on the hotel's policy, guests may be able to:
- View their reservation
- Update permitted contact details
- Request cancellation
- Review payment status
- View documents

Changes must be validated against the saved reservation terms and current state.

## Page 56 — Booking Status
**Route:** `/booking/status`

Show:
- Pending payment
- Payment processing
- Confirmed
- Cancelled
- Expired
- Action required

This page helps users recover from delayed payment confirmations without submitting duplicate bookings.

## Page 57 — Informational Pages
**Routes:**
- `/about`
- `/contact`
- `/amenities`
- `/location`
- `/policies`
- `/privacy`
- `/terms`

Policies and legal content should be reviewed before publication.

---

# 4. Platform Administration pages

These pages are for the company operating the HMS, not ordinary hotel staff.

### Page 58 — Platform Overview
**Route:** `/platform`

Show:
- Total tenants
- Active properties
- Active users
- Platform health
- Payment integration health
- Recent platform events

### Page 59 — Tenant Directory
**Route:** `/platform/tenants`

Features:
- Search tenants
- View status
- View properties
- View tenant creation date
- Suspend or reactivate where authorized

### Page 60 — Tenant Details
**Route:** `/platform/tenants/[id]`

Sections:
- Business profile
- Properties
- Memberships
- Subscription status
- Feature entitlements
- Integration status
- Audit events

### Page 61 — Subscription and Plan Management
**Route:** `/platform/subscriptions`

The first release should support administrative subscription status and plan assignment. Automated subscription collection is deferred.

### Page 62 — Feature Entitlements
**Route:** `/platform/features`

Manage feature access for tenants, including future multi-property capabilities and advanced reporting.

### Page 63 — Platform Audit and Support
**Route:** `/platform/audit-log`

Track:
- Administrative changes
- Tenant suspensions
- Permission changes
- Exceptional support access
- Integration configuration changes

Support access to tenant data must be restricted, justified, and auditable.

### Page 64 — Platform Settings
**Route:** `/platform/settings`

Manage:
- Platform branding
- Operational defaults
- Security configuration
- Feature defaults
- System-wide integration settings

Hotel-specific credentials must remain separate from platform-wide settings.

---

# 5. Recommended design system

## Visual direction

Use a clean, premium hospitality aesthetic rather than an overly decorative interface.

**Recommended starting palette:**
- Deep navy or dark charcoal for primary navigation
- Warm white or light neutral for page backgrounds
- Teal or emerald as the primary action color
- Amber for warnings and pending states
- Red for destructive actions and critical errors
- Neutral gray for secondary information

These are starting recommendations and can be adapted to the product's final brand identity.

## Typography

Use a highly readable sans-serif typeface.

Recommended hierarchy:
- Page title: 24–32 px
- Section title: 18–22 px
- Body text: 14–16 px
- Supporting labels: 12–14 px

Avoid making important operational information too small.

## Components to build once and reuse

- Sidebar and top navigation
- Breadcrumbs
- Buttons and action menus
- Search and filter bars
- Data tables
- Status badges
- Summary cards
- Date-range picker
- Room cards
- Guest summary panel
- Reservation timeline
- Payment summary
- Confirmation dialogs
- Toast notifications
- Empty states
- Loading skeletons
- Error states
- Pagination
- Form validation
- Printable document layouts

Use accessible labels, keyboard navigation, visible focus indicators, and text labels in addition to status colors.

---

# 6. Essential user journeys

## Journey A — Walk-in guest

Dashboard → Walk-in Booking → Guest Details → Check Availability → Select Room → Review Charges → Record Payment → Check In → Room Board.

## Journey B — Online guest booking

Homepage → Search Rooms → Room Details → Guest Details → Optional Specific-Room Selection → Review → Pay → Backend Verification → Booking Confirmation.

## Journey C — Staff reservation

Reservation List → Create Reservation → Select Dates → Check Availability → Select Room Type or Physical Room → Add Guest → Review Rate and Policy → Create Reservation → Confirmation.

## Journey D — Guest checkout

Front Desk → Departures → Reservation Details → Review Outstanding Charges → Record or Verify Payment → Check Out → Create Housekeeping Task → Print Receipt.

## Journey E — Housekeeping

Housekeeping Dashboard → Assigned Tasks → Room Details → Start Cleaning → Complete Cleaning → Inspection, if required → Update Housekeeping Status.

## Journey F — Payment reconciliation

Payments Overview → Reconciliation → Review Unmatched Transactions → Verify Provider Details → Resolve Discrepancy → Record Audit Event.

---

# 7. MVP implementation priorities

Not every page needs to be built at the same time.

## Phase 1 — Essential operations

Build first:
1. Sign In and Password Recovery
2. Initial Hotel Setup
3. Main Dashboard
4. Front Desk
5. Room Board
6. Reservation List
7. Create Reservation
8. Reservation Details
9. Room Types
10. Physical Rooms
11. Guest Directory and Profile
12. Payments Overview
13. Record Manual Payment
14. Invoices
15. Housekeeping Dashboard
16. Booking Policies
17. Staff Directory and Permissions

**Goal:** The hotel can manage reservations, rooms, guests, payments, and daily operations.

## Phase 2 — Online bookings and payments

Build next:
1. Guest Homepage
2. Room Search
3. Room Details
4. Guest Details and Booking
5. Specific-Room Selection
6. Review and Payment
7. Payment Processing
8. Booking Confirmation
9. Booking Lookup and Status
10. Paystack Settings
11. Payment Details
12. Refund Management
13. Payment Reconciliation

**Goal:** Guests can book online and the hotel can reliably verify payments.

## Phase 3 — Operational depth

Add:
1. Reservation Calendar
2. Rate Calendar
3. Room Blocks
4. Maintenance Dashboard
5. Reports
6. Audit Log
7. Notification Center
8. Document improvements
9. Guest self-service booking management

**Goal:** Improve efficiency, visibility, and reporting.

## Phase 4 — Commercial SaaS expansion

Add:
1. Platform Overview
2. Tenant Directory
3. Tenant Details
4. Feature Entitlements
5. Subscription Management
6. Multi-property switching
7. Additional payment providers
8. Advanced commercial reporting

**Goal:** Turn the initial hotel installation into a repeatable product that can be deployed to other hotels.

---

# 8. UI acceptance criteria

The interface is ready for MVP release when:

- Every page enforces the correct permissions.
- Forms validate required fields and display useful errors.
- Loading, empty, error, and success states are implemented.
- The main workflows work on desktop, tablet, and mobile.
- Reservation creation cannot bypass availability protection.
- Payment status is driven by verified backend results.
- Room statuses are clearly distinguished.
- Hotel policies are visible before guests confirm a booking.
- Users cannot access another tenant's data by changing a URL or record ID.
- Important financial and reservation actions are audited.
- Keyboard navigation and accessible form labels are supported.
- Destructive actions require confirmation.
- Reports and dashboard metrics use consistent definitions.
- The booking flow recovers safely from delayed payment confirmation or network interruption.

## Final recommendation

Start the interface design with **five high-value screens**:

1. Main Dashboard
2. Room Board
3. Reservation List
4. Reservation Details
5. Guest Booking and Payment Flow

These screens establish the visual language and validate the most important hotel workflows. Once approved, extend the same components and design rules to the remaining pages.

The page inventory above is the target scope, not a requirement to build all 64 pages before launch. Prioritize the essential operational workflows, then add online booking and the commercial SaaS administration features in stages.