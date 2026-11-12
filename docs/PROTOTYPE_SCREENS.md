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
| Room Details (physical room) | built | `/app/rooms/[id]`, opened from the room number on `/app/rooms`; room type setup stays at `/app/settings/rooms` |
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
| Operational Settings | built | `/app/settings/hotel` holds the check-in and check-out times, contact details, hotel facilities and Instagram and Facebook links (migration 105) |
| Guest Homepage | built | `/`: hero, search card, room cards (migration 096), info pills; offers (migration 102) and guest reviews (migration 104) are shown; a "Near the hotel" section lists places the hotel writes itself (migration 119, `/app/settings/places`, up to 8, plain text) |
| Guest Room Details | built | `/rooms/[roomTypeId]`: every picture, description, amenities, who it sleeps, a 14-night price calendar and a Book form; opened from "View room" on the homepage cards (migration 106 `guest_room_type`) |
| Guest Policies / Contact / Privacy | built | `/policies`, `/contact`, `/privacy` (privacy text needs review) |
| Branding & Theme Editor | built | `/app/settings/hotel`: logo and room photos, and the hotel's look (Standard, Luxury, Modern or Classic; migration 093) for the guest site and the staff screens, plus an optional main colour over it (migration 099; refused if white text on it or links on the page fall below WCAG AA 4.5:1). heading and body fonts over it (migration 100), corner style (sharp or round, migration 118), and a live preview of the choices before saving. Not built: other colours (secondary, accent, background), draft versus published |
| Staff Management | built | `/app/staff` |
| Staff Permissions | built | `/app/staff/roles` (custom roles) |
| Audit Log | built | `/app/settings/history` (Setup history) |
| Reports & Analytics | built | `/app/reports`, `/app/reports/occupancy`, `/app/reports/channels` |

## Built, but not in the prototype

- Guest booking site: `/`, `/reserve`, `/booking/[token]` and its cancel and change pages, `/booking/find`
- Payments to verify (`/app/payments`), guest requests (`/app/requests`), guest emails (`/app/emails`)
- Guest reviews: written at `/booking/[token]/review`, moderated at `/app/settings/reviews`, shown on the homepage (migration 104)
- Billing, the hotel's own view of its plan and platform invoices (`/app/settings/billing`, migration 103)
- Offers for the homepage (`/app/settings/offers`, migration 102)
- Discounts (`/app/settings/discounts`) and tax rules (`/app/settings/tax`)
- Guest booking extras (2026-11-12): Address and Special requests on the booking form (migration 107; staff see both on the reservation page); on a confirmed booking an Add to calendar file (`/booking/[token]/calendar`), Print or save as PDF, and Contact the hotel; search results can be sorted and filtered (price, sleeps at least, amenity), show the nights times the rate plus tax, and list sold-out room types as not available
- Guest homepage reviews now sit under the room cards (they had been rendered inside every card)
- Platform administration: `/platform` (with a search by name, short name or plan, and a status filter), `/platform/new`, `/platform/[tenantId]`, `/platform/plans`, and `/platform/entitlements` (migration 108: every hotel against every feature flag, read only), `/platform/tickets` (support tickets with notes and a status, migration 110), and on each hotel's page "Can guests book?" (migration 109: counts and settings only, the platform's safe stand-in for inspecting a hotel's setup)
- Prototype platform screens (Subscription Status, Feature Entitlements Matrix, Support Workspace), checked 2026-11-12: subscription and entitlements are covered by the platform pages above; support tickets are built (`/platform/tickets`, migration 110); impersonation is built as an approved, audited access request with no login-as (`/platform/access`, migration 111: a read-only, no-secrets view of a hotel's setup for 1, 4 or 24 hours, approved by a different admin); flags: Branding, Housekeeping, Maintenance and Audit Log are enforced flags (migration 112); Multi-property and API access are not flags because the system has nothing to switch off (no screen adds a property, no public API); **not built**: a manual-or-automated billing field

## Totals

52 screens: 51 built, 1 partial, 0 not built. The prototype's "Experience Ibadan" cards are built as the hotel-managed "Near the hotel" list. The guest booking screens (Room Details included) are listed under Property & System.
