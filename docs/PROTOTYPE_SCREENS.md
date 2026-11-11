# Prototype screens

The 52 screens in the original prototype (`Hms-Full-Platform.html`, kept outside this repo: it is a 1.1 MB compiled bundle with
sample data and is a visual and workflow reference only), and where each one lives in the app.

Checked 2026-11-10 by screen name and route, not by layout or fields. "Built" means a screen that does the job exists.
Staff routes are under `/app`. Open work is tracked in `TODO.md` under "Prototype parity".

Status: **built**, **partial** (part of the job is done, or only another role can do it), **not built**.

## Authentication

| Prototype screen | Status | Where |
| --- | --- | --- |
| Sign-in | built | `/login` |
| Forgot Password | built | `/forgot-password` |
| Reset Password | built | `/reset-password` |
| Hotel Setup Wizard | built | `/app/setup` (owner guide over the five setup steps); `/platform/new` for a platform admin to onboard a hotel |
| Staff Invitation | built | `/app/staff` (Invite) |

## Overview

| Prototype screen | Status | Where |
| --- | --- | --- |
| Dashboard Overview | built | `/app` |
| Notifications | built | `/app/notifications` |
| Profile & Preferences | built | `/app/profile`: name, phone, screen spacing (comfortable or compact), a read-only summary of roles and what they allow, change password. The prototype's theme choice (Luxury, Modern, Classic) is a hotel-wide look, so it is chosen on Hotel details (`/app/settings/hotel`), not here |

## Front Desk

| Prototype screen | Status | Where |
| --- | --- | --- |
| Front Desk Workspace | built | `/app/front-desk` |
| Room Status Board | built | `/app/rooms` |
| Walk-in Reservation | built | `/app/reservations/new` |
| Check-in Workflow | built | per-room button on `/app/reservations/[id]`, not a separate screen |
| Check-out Workflow | built | per-room button on `/app/reservations/[id]`, not a separate screen |
| Room Transfer | built | "Move to another room" on `/app/reservations/[id]`; same room type only |

## Reservations

| Prototype screen | Status | Where |
| --- | --- | --- |
| Reservation List | built | `/app/reservations` |
| Create Reservation | built | `/app/reservations/new` (up to 5 rooms) |
| Reservation Details | built | `/app/reservations/[id]` |
| Reservation Calendar | built | `/app/rooms/calendar`, `/app/front-desk/calendar` |
| Edit Reservation | built | "Change dates or guests" on `/app/reservations/[id]` |
| Documents & Comms | built | `/app/reservations/[id]/documents`, `/app/emails` |

## Room Inventory

| Prototype screen | Status | Where |
| --- | --- | --- |
| Room Type List | built | `/app/settings/rooms` (one screen for all four room screens) |
| Create Room Type | built | `/app/settings/rooms` |
| Physical Rooms | built | `/app/settings/rooms` |
| Room Details | built | `/app/settings/rooms` |
| Availability Calendar | built | `/app/rooms/calendar` |
| Blocks & Out-of-Service | built | block and unblock on `/app/rooms` and `/app/rooms/calendar` |

## Guests

| Prototype screen | Status | Where |
| --- | --- | --- |
| Guest Directory | built | `/app/guests` |
| Guest Profile | built | `/app/guests/[id]` |
| Create / Edit Guest | built | create at `/app/guests/new` (audited `create_guest`, migration 091), edit on `/app/guests/[id]` |

## Housekeeping

| Prototype screen | Status | Where |
| --- | --- | --- |
| Housekeeping Board | built | `/app/housekeeping` |
| Housekeeping Task | built | one button per room on `/app/housekeeping` |
| Maintenance Board | built | `/app/maintenance` |
| Maintenance Task | built | `/app/maintenance/[id]` |

## Payments

| Prototype screen | Status | Where |
| --- | --- | --- |
| Payments Overview | built | `/app/payments/all`; the verify queue stays at `/app/payments` |
| Payment Details | built | `/app/payments/[id]`, read-only; verify, reverse and refund stay where they were |
| Record Manual Payment | built | on `/app/reservations/[id]` |
| Invoice List | built | `/app/invoices`, booking invoices and invoices for extras; booking invoices show what is still owing; the invoice on the Documents page can be printed or saved as PDF and emailed to the guest (migration 095) |
| Invoice Details | built | `/app/reservations/[id]/folio-invoice/[invoiceId]` |
| Refund Management | built | `/app/refunds` |
| Reconciliation | built | `/app/reconciliation` |

## Rates & Policies

| Prototype screen | Status | Where |
| --- | --- | --- |
| Rate Plans | built | `/app/settings/rates` |
| Rate Calendar | built | `/app/settings/rates` (nightly prices) |
| Booking & Cancellation | built | `/app/settings/policies` |
| Payment Settings | built | `/app/settings/policies` (full payment or a deposit percent); Paystack accounts are set by the platform admin by design |
| Paystack Settings | partial | set by the platform admin on `/platform/[tenantId]`; the secret lives in the environment by design |

## Property & System

| Prototype screen | Status | Where |
| --- | --- | --- |
| Property Profile | built | `/app/settings/hotel` |
| Operational Settings | partial | check-in and check-out times are on `/app/settings/hotel`; no single operations screen |
| Guest Homepage | built | `/`: hero, search card, room cards (migration 096), info pills; offers, reviews and experience not built (no data) |
| Guest Policies / Contact / Privacy | built | `/policies`, `/contact`, `/privacy` (privacy text needs review) |
| Branding & Theme Editor | built | `/app/settings/hotel`: logo and room photos, and the hotel's look (Standard, Luxury, Modern or Classic; migration 093) for the guest site and the staff screens. Free-form colour editing is not built |
| Staff Management | built | `/app/staff` |
| Staff Permissions | built | `/app/staff/roles` (custom roles) |
| Audit Log | built | `/app/settings/history` (Setup history) |
| Reports & Analytics | built | `/app/reports`, `/app/reports/occupancy`, `/app/reports/channels` |

## Built, but not in the prototype

- Guest booking site: `/`, `/reserve`, `/booking/[token]` and its cancel and change pages, `/booking/find`
- Payments to verify (`/app/payments`), guest requests (`/app/requests`), guest emails (`/app/emails`)
- Discounts (`/app/settings/discounts`) and tax rules (`/app/settings/tax`)
- Platform administration: `/platform`, `/platform/new`, `/platform/[tenantId]`

## Totals

52 screens: 50 built, 2 partial, 0 not built.
